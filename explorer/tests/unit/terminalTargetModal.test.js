import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
    buildTerminalLaunchUrl,
    cancelTerminalTargetDiscovery,
    normalizeTerminalDiscoveryPayload,
    openTerminalLaunchWindow,
    readBrowserCsrfToken,
    requestTerminalTargetDiscovery,
    TerminalTargetModal
} from '../../web-components/modals/terminal-target-modal/terminal-target-modal.js';

const DISCOVERY_ID = 'D'.repeat(32);
const BOX_LAUNCH = 'B'.repeat(32);
const AGENT_LAUNCH_A = 'A'.repeat(32);
const AGENT_LAUNCH_Z = 'Z'.repeat(32);

function target(overrides = {}) {
    return {
        launch: AGENT_LAUNCH_A,
        kind: 'agent',
        label: 'Explorer',
        detail: 'AssistOSExplorer/explorer',
        access: 'rw',
        cwdDisplay: '/workspace/projects/demo',
        ...overrides,
    };
}

function discoveryPayload(overrides = {}) {
    return {
        ok: true,
        discovery: {
            id: DISCOVERY_ID,
            directory: 'projects/demo',
            expiresAt: Date.now() + 300000,
            agentTargetsAvailable: true,
            targets: [
                target({ launch: AGENT_LAUNCH_Z, label: 'Zulu', detail: 'repo/zulu' }),
                target({
                    launch: BOX_LAUNCH,
                    kind: 'box',
                    label: 'Ploinky Box',
                    detail: 'Workspace runtime',
                }),
                target({ launch: AGENT_LAUNCH_A, label: 'alpha', detail: 'repo/alpha', access: 'ro' }),
            ],
            ...overrides,
        },
    };
}

class FakeElement {
    constructor(tagName, { fragment = false } = {}) {
        this.tagName = tagName;
        this.fragment = fragment;
        this.children = [];
        this.dataset = {};
        this.attributes = new Map();
        this.hidden = false;
        this.disabled = false;
        this.textContent = '';
        this.className = '';
    }

    appendChild(child) {
        if (child?.fragment) {
            this.children.push(...child.children);
        } else {
            this.children.push(child);
        }
        return child;
    }

    replaceChildren(...children) {
        this.children = [...children];
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    focus() {
        this.focused = true;
    }
}

function textTree(element) {
    return `${element?.textContent || ''}${(element?.children || []).map(textTree).join('')}`;
}

test('terminal discovery keeps only safe display fields and sorts Box first', () => {
    const payload = discoveryPayload();
    payload.discovery.targets[0].containerId = 'f'.repeat(64);
    payload.discovery.targets[0].runtime = 'podman';
    payload.discovery.targets[0].mountSource = '/physical/private/path';
    payload.discovery.targets[0].environment = { SECRET: 'must-not-survive' };

    const discovery = normalizeTerminalDiscoveryPayload(payload);

    assert.deepEqual(discovery.targets.map((entry) => [entry.kind, entry.label]), [
        ['box', 'Ploinky Box'],
        ['agent', 'alpha'],
        ['agent', 'Zulu'],
    ]);
    assert.deepEqual(Object.keys(discovery.targets[2]).sort(), [
        'access',
        'cwdDisplay',
        'detail',
        'kind',
        'label',
        'launch',
    ]);
    assert.doesNotMatch(JSON.stringify(discovery), /physical|SECRET|containerId|"runtime":/);
});

test('agent sorting is stable for case-insensitive label and detail ties', () => {
    const firstLaunch = `1${'x'.repeat(31)}`;
    const secondLaunch = `0${'x'.repeat(31)}`;
    const discovery = normalizeTerminalDiscoveryPayload(discoveryPayload({
        targets: [
            target({ launch: firstLaunch, label: 'alpha', detail: 'Repo/Same', cwdDisplay: '/z' }),
            target({ launch: secondLaunch, label: 'ALPHA', detail: 'repo/same', cwdDisplay: '/a' }),
            target({ launch: BOX_LAUNCH, kind: 'box', label: 'Ploinky Box' }),
        ],
    }));

    assert.deepEqual(discovery.targets.map((entry) => entry.launch), [
        BOX_LAUNCH,
        firstLaunch,
        secondLaunch,
    ]);
});

test('terminal discovery rejects missing Box, duplicate launches, unsafe text, and oversized target sets', () => {
    assert.throws(
        () => normalizeTerminalDiscoveryPayload(discoveryPayload({ targets: [target()] })),
        /one Box target/
    );
    assert.throws(
        () => normalizeTerminalDiscoveryPayload(discoveryPayload({
            targets: [
                target({ launch: BOX_LAUNCH, kind: 'box', label: 'Ploinky Box' }),
                target({ launch: BOX_LAUNCH }),
            ],
        })),
        /launch identifier/
    );
    assert.throws(
        () => normalizeTerminalDiscoveryPayload(discoveryPayload({
            targets: [
                target({ launch: BOX_LAUNCH, kind: 'box', label: 'Ploinky Box' }),
                target({ label: 'unsafe\nlabel' }),
            ],
        })),
        /label/
    );
    const manyTargets = [target({ launch: BOX_LAUNCH, kind: 'box', label: 'Ploinky Box' })];
    for (let index = 0; index < 64; index += 1) {
        manyTargets.push(target({
            launch: `${String(index).padStart(2, '0')}${'x'.repeat(30)}`,
            label: `Agent ${index}`,
        }));
    }
    assert.throws(
        () => normalizeTerminalDiscoveryPayload(discoveryPayload({ targets: manyTargets })),
        /target list/
    );
});

test('discovery and cancel use same-origin mutation protection and exact bodies', async (t) => {
    const previousDocument = globalThis.document;
    globalThis.document = { cookie: 'unrelated=1; ploinky_browser_csrf=v1.session-proof; other=2' };
    t.after(() => { globalThis.document = previousDocument; });
    const calls = [];
    let cancellationJsonCalls = 0;
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        if (options.method === 'DELETE') {
            return {
                ok: true,
                status: 200,
                async json() {
                    cancellationJsonCalls += 1;
                    return { ok: true };
                },
            };
        }
        return {
            ok: true,
            status: 200,
            async json() { return discoveryPayload(); },
        };
    };

    await requestTerminalTargetDiscovery('projects/demo', { fetchImpl });
    await cancelTerminalTargetDiscovery(DISCOVERY_ID, { fetchImpl, keepalive: true });

    assert.equal(readBrowserCsrfToken(globalThis.document.cookie), 'v1.session-proof');
    assert.equal(calls[0].url, '/webtty/target-discoveries');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[0].options.headers['X-Ploinky-Browser-CSRF-Token'], 'v1.session-proof');
    assert.deepEqual(JSON.parse(calls[0].options.body), { dir: 'projects/demo' });
    assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)), ['dir']);
    assert.equal(calls[1].url, `/webtty/target-discoveries/${DISCOVERY_ID}`);
    assert.equal(calls[1].options.method, 'DELETE');
    assert.equal(calls[1].options.keepalive, true);
    assert.equal(cancellationJsonCalls, 1);
});

test('cancel consumes exactly one body and accepts only the exact 200 and 404 contracts', async () => {
    for (const [status, payload] of [
        [200, { ok: true }],
        [404, { ok: false, error: 'not_found' }],
    ]) {
        let jsonCalls = 0;
        const result = await cancelTerminalTargetDiscovery(DISCOVERY_ID, {
            fetchImpl: async () => ({
                status,
                async json() {
                    jsonCalls += 1;
                    return payload;
                },
            }),
        });
        assert.equal(result, true);
        assert.equal(jsonCalls, 1);
    }

    const invalidResponses = [
        ['malformed JSON', 200, async () => { throw new SyntaxError('invalid JSON'); }],
        ['unexpected success status', 201, async () => ({ ok: true })],
        ['empty success status', 204, async () => ({ ok: true })],
        ['false success', 200, async () => ({ ok: false })],
        ['extra success field', 200, async () => ({ ok: true, extra: true })],
        ['wrong not-found flag', 404, async () => ({ ok: true, error: 'not_found' })],
        ['wrong not-found code', 404, async () => ({ ok: false, error: 'gone' })],
        ['extra not-found field', 404, async () => ({ ok: false, error: 'not_found', extra: true })],
        ['server failure', 500, async () => ({ ok: false, error: 'not_found' })],
    ];
    for (const [name, status, json] of invalidResponses) {
        let jsonCalls = 0;
        await assert.rejects(
            cancelTerminalTargetDiscovery(DISCOVERY_ID, {
                fetchImpl: async () => ({
                    status,
                    async json() {
                        jsonCalls += 1;
                        return json();
                    },
                }),
            }),
            (error) => error?.message === 'The terminal target discovery could not be cancelled.'
                && error?.status === status,
            name,
        );
        assert.equal(jsonCalls, 1, name);
    }
});

test('target selection opens an isolated no-referrer fragment and closes only for a non-null popup', (t) => {
    const previousWindow = globalThis.window;
    const previousAssistOS = globalThis.assistOS;
    const opened = [];
    const navigated = [];
    const anchors = [];
    const closed = [];
    t.after(() => {
        globalThis.window = previousWindow;
        globalThis.assistOS = previousAssistOS;
    });
    globalThis.window = {
        open(...args) {
            opened.push(args);
            return {
                opener: globalThis.window,
                document: {
                    createElement(tagName) {
                        const element = {
                            tagName,
                            href: '',
                            target: '',
                            rel: '',
                            referrerPolicy: '',
                            click() { navigated.push(this.href); },
                        };
                        anchors.push(element);
                        return element;
                    },
                    body: { appendChild() {} },
                },
            };
        },
    };
    globalThis.assistOS = { UI: { closeModal: (element) => closed.push(element) } };
    const modal = Object.create(TerminalTargetModal.prototype);
    Object.assign(modal, {
        closed: false,
        handedOff: false,
        targetsByLaunch: new Map([[BOX_LAUNCH, target({
            launch: BOX_LAUNCH,
            kind: 'box',
            label: 'Ploinky Box',
        })]]),
        warningElement: { hidden: true, dataset: {} },
        statusElement: { textContent: '' },
        element: { id: 'modal' },
        clearExpiryTimer() {},
    });

    assert.equal(modal.selectTarget({ dataset: { launch: BOX_LAUNCH } }), true);
    assert.deepEqual(opened, [[
        'about:blank',
        '_blank',
    ]]);
    assert.deepEqual(navigated, [`/webtty/#launch=${BOX_LAUNCH}`]);
    assert.deepEqual(anchors, [{
        tagName: 'a',
        href: `/webtty/#launch=${BOX_LAUNCH}`,
        target: '_self',
        rel: 'noopener noreferrer',
        referrerPolicy: 'no-referrer',
        click: anchors[0].click,
    }]);
    assert.deepEqual(closed, [modal.element]);
    assert.equal(modal.handedOff, true);
    assert.doesNotMatch(navigated[0], /(?:dir|container|runtime|cwd)=/);
});

test('attach popup preserves isolation and uses only the exact attach fragment', () => {
    const attach = 'T'.repeat(32);
    const anchors = [];
    const popup = {
        opener: {},
        document: {
            createElement() { const anchor = { click() {} }; anchors.push(anchor); return anchor; },
            body: { appendChild() {} },
        },
    };
    assert.equal(buildTerminalLaunchUrl({ attach }), `/webtty/#attach=${attach}`);
    assert.equal(openTerminalLaunchWindow({ attach }, { open: () => popup }), popup);
    assert.equal(popup.opener, null);
    assert.equal(anchors[0].href, `/webtty/#attach=${attach}`);
    assert.equal(anchors[0].referrerPolicy, 'no-referrer');
    assert.equal(anchors[0].rel, 'noopener noreferrer');
    assert.equal(openTerminalLaunchWindow({ attach }, { open: () => null }), null);
    assert.throws(() => buildTerminalLaunchUrl({ attach, launch: BOX_LAUNCH }), /Invalid/);
    assert.throws(() => buildTerminalLaunchUrl({ attach: 'A'.repeat(33) }), /Invalid/);
});

test('ready rendering supports 15 semantic rows, read-only badges, and safe availability messages', (t) => {
    const previousDocument = globalThis.document;
    globalThis.document = {
        createElement: (tagName) => new FakeElement(tagName),
        createDocumentFragment: () => new FakeElement('#fragment', { fragment: true }),
    };
    t.after(() => { globalThis.document = previousDocument; });
    const listElement = new FakeElement('ul');
    const modal = Object.create(TerminalTargetModal.prototype);
    Object.assign(modal, {
        targetsByLaunch: new Map(),
        listElement,
        noticeElement: new FakeElement('p'),
        warningElement: new FakeElement('div'),
        retryButton: new FakeElement('button'),
        refreshButton: new FakeElement('button'),
        statusElement: new FakeElement('p'),
    });
    const targets = [target({
        launch: BOX_LAUNCH,
        kind: 'box',
        label: 'Ploinky Box',
        detail: 'Workspace runtime',
    })];
    for (let index = 0; index < 14; index += 1) {
        targets.push(target({
            launch: `${String(index).padStart(2, '0')}${'q'.repeat(30)}`,
            label: index < 2 ? 'Duplicate label' : `Agent ${index}`,
            detail: index === 0 ? 'repo/first' : `repo/${index}`,
            access: index === 3 ? 'ro' : 'rw',
        }));
    }

    modal.renderReady({ targets, agentTargetsAvailable: true });

    assert.equal(listElement.children.length, 15);
    assert.match(textTree(listElement.children[0]), /Ploinky Box/);
    assert.equal(modal.targetsByLaunch.size, 15);
    assert.equal(modal.noticeElement.hidden, false);
    assert.equal(modal.warningElement.hidden, true);
    assert.match(textTree(listElement.children[1]), /repo\/first/);
    assert.match(textTree(listElement.children[2]), /repo\/1/);
    assert.match(textTree(listElement.children[4]), /Read only/);
    assert.equal(listElement.attributes.get('aria-busy'), 'false');

    modal.renderReady({ targets: [targets[0]], agentTargetsAvailable: false });
    assert.equal(listElement.children.length, 1);
    assert.match(modal.warningElement.textContent, /temporarily unavailable/);
    assert.equal(modal.warningElement.hidden, false);

    modal.renderReady({ targets: [targets[0]], agentTargetsAvailable: true });
    assert.match(modal.warningElement.textContent, /No running agent/);
});

test('popup blocking keeps the chooser open with an actionable status', (t) => {
    const previousWindow = globalThis.window;
    const previousAssistOS = globalThis.assistOS;
    t.after(() => {
        globalThis.window = previousWindow;
        globalThis.assistOS = previousAssistOS;
    });
    globalThis.window = { open: () => null };
    const closed = [];
    globalThis.assistOS = { UI: { closeModal: (...args) => closed.push(args) } };
    const warningElement = { hidden: true, dataset: {}, textContent: '' };
    const statusElement = { textContent: '' };
    const button = { dataset: { launch: AGENT_LAUNCH_A }, focusCalled: false, focus() { this.focusCalled = true; } };
    const modal = Object.create(TerminalTargetModal.prototype);
    Object.assign(modal, {
        closed: false,
        handedOff: false,
        targetsByLaunch: new Map([[AGENT_LAUNCH_A, target()]]),
        warningElement,
        statusElement,
        clearExpiryTimer() {},
    });

    assert.equal(modal.selectTarget(button), false);
    assert.equal(modal.handedOff, false);
    assert.equal(warningElement.hidden, false);
    assert.match(warningElement.textContent, /Allow popups/);
    assert.equal(statusElement.textContent, 'No terminal was opened.');
    assert.equal(button.focusCalled, true);
    assert.deepEqual(closed, []);
});

test('launch URL accepts only opaque random identifiers', () => {
    assert.equal(buildTerminalLaunchUrl(BOX_LAUNCH), `/webtty/#launch=${BOX_LAUNCH}`);
    assert.throws(() => buildTerminalLaunchUrl('container-name'), /launch identifier/);
    assert.throws(() => buildTerminalLaunchUrl('../escape'), /launch identifier/);
});

test('popup probe severs opener before fragment navigation and closes an unsafe partial popup', () => {
    const events = [];
    const anchor = {
        click() { events.push(['click']); },
    };
    const popup = {
        _opener: { parent: true },
        get opener() { return this._opener; },
        set opener(value) { events.push(['opener', value]); this._opener = value; },
        document: {
            createElement(tag) { events.push(['create', tag]); return anchor; },
            body: { appendChild(element) { events.push([
                'append', element.href, element.target, element.rel, element.referrerPolicy,
            ]); } },
        },
    };
    const windowRef = { open: (...args) => { events.push(['open', ...args]); return popup; } };

    assert.equal(openTerminalLaunchWindow(AGENT_LAUNCH_A, windowRef), popup);
    assert.deepEqual(events, [
        ['open', 'about:blank', '_blank'],
        ['opener', null],
        ['create', 'a'],
        ['append', `/webtty/#launch=${AGENT_LAUNCH_A}`, '_self', 'noopener noreferrer', 'no-referrer'],
        ['click'],
    ]);

    let closed = false;
    const unsafePopup = {
        set opener(_value) {},
        get opener() { return null; },
        document: { createElement() { throw new Error('unavailable'); } },
        close() { closed = true; },
    };
    assert.equal(openTerminalLaunchWindow(AGENT_LAUNCH_A, { open: () => unsafePopup }), null);
    assert.equal(closed, true);

    let navigated = false;
    let isolationFailureClosed = false;
    const openerIsolationFailure = {
        get opener() { return { stillConnected: true }; },
        set opener(_value) {},
        document: {
            createElement() { return { click() { navigated = true; } }; },
            body: { appendChild() {} },
        },
        close() { isolationFailureClosed = true; },
    };
    assert.equal(openTerminalLaunchWindow(
        AGENT_LAUNCH_A,
        { open: () => openerIsolationFailure }
    ), null);
    assert.equal(isolationFailureClosed, true);
    assert.equal(navigated, false);
});

test('afterRender gives the actual native dialog the chooser title as its accessible name', () => {
    const dialog = new FakeElement('dialog');
    const fields = new Map([
        ['#terminalTargetDirectory', new FakeElement('div')],
        ['#terminalTargetStatus', new FakeElement('p')],
        ['#terminalTargetWarning', new FakeElement('div')],
        ['#terminalTargetNotice', new FakeElement('p')],
        ['#terminalTargetList', new FakeElement('ul')],
        ['#terminalTargetRetry', new FakeElement('button')],
        ['#terminalTargetRefresh', new FakeElement('button')],
    ]);
    const element = {
        closest(selector) { return selector === 'dialog' ? dialog : null; },
        querySelector(selector) { return fields.get(selector); },
        removeEventListener() {},
        addEventListener() {},
    };
    const modal = Object.create(TerminalTargetModal.prototype);
    Object.assign(modal, {
        element,
        directory: 'projects/demo',
        targetsByLaunch: new Map(),
        viewState: 'loading',
        viewMessage: 'Finding available terminal targets…',
        currentDiscovery: null,
        boundKeydown() {},
        started: true,
    });

    modal.afterRender();

    assert.equal(dialog.attributes.get('aria-labelledby'), 'terminalTargetTitle');
    assert.equal(fields.get('#terminalTargetDirectory').textContent, '/projects/demo');
});

test('refresh invalidates every prior choice before requesting a replacement batch', async (t) => {
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    const events = [];
    globalThis.document = { cookie: 'ploinky_browser_csrf=refresh-proof' };
    globalThis.fetch = async (url, options) => {
        events.push(['cancel', url, options.method]);
        return {
            ok: true,
            status: 200,
            async json() {
                events.push(['cancel-body']);
                return { ok: true };
            },
        };
    };
    t.after(() => {
        globalThis.document = previousDocument;
        globalThis.fetch = previousFetch;
    });

    const modal = Object.create(TerminalTargetModal.prototype);
    Object.assign(modal, {
        closed: false,
        handedOff: false,
        requestSequence: 7,
        discoveryController: null,
        discoveryId: DISCOVERY_ID,
        discoveryExpiresAt: Date.now() + 1000,
        clearExpiryTimer() { events.push(['clear-timer']); },
        renderLoading(message) { events.push(['loading', message]); },
        async discoverTargets() { events.push(['discover']); },
    });

    await modal.refreshTargets();

    assert.deepEqual(events, [
        ['clear-timer'],
        ['loading', 'Refreshing available terminal targets…'],
        ['cancel', `/webtty/target-discoveries/${DISCOVERY_ID}`, 'DELETE'],
        ['cancel-body'],
        ['discover'],
    ]);
    assert.equal(modal.discoveryId, '');
    assert.equal(modal.discoveryExpiresAt, 0);
});

test('refresh rejects an invalid cancellation body before requesting a successor discovery', async (t) => {
    const previousDocument = globalThis.document;
    const previousFetch = globalThis.fetch;
    const events = [];
    globalThis.document = { cookie: 'ploinky_browser_csrf=refresh-failure-proof' };
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        async json() {
            events.push(['cancel-body']);
            return { ok: true, unexpected: true };
        },
    });
    t.after(() => {
        globalThis.document = previousDocument;
        globalThis.fetch = previousFetch;
    });

    const modal = Object.create(TerminalTargetModal.prototype);
    Object.assign(modal, {
        closed: false,
        handedOff: false,
        requestSequence: 3,
        discoveryController: null,
        discoveryId: DISCOVERY_ID,
        discoveryExpiresAt: Date.now() + 1000,
        clearExpiryTimer() { events.push(['clear-timer']); },
        renderLoading(message) { events.push(['loading', message]); },
        renderError(message) { events.push(['error', message]); },
        async discoverTargets() { events.push(['discover']); },
    });

    await modal.refreshTargets();

    assert.deepEqual(events, [
        ['clear-timer'],
        ['loading', 'Refreshing available terminal targets…'],
        ['cancel-body'],
        ['error', 'The previous terminal choices could not be invalidated. Try again.'],
    ]);
    assert.equal(modal.discoveryId, DISCOVERY_ID);
    assert.notEqual(modal.discoveryExpiresAt, 0);
});

test('Escape prevents propagation and invokes chooser cancellation', () => {
    const modal = Object.create(TerminalTargetModal.prototype);
    const events = [];
    modal.closeModal = () => events.push('close');

    modal.handleKeydown({
        key: 'Escape',
        preventDefault() { events.push('prevent'); },
        stopPropagation() { events.push('stop'); },
    });
    modal.handleKeydown({ key: 'Enter' });

    assert.deepEqual(events, ['prevent', 'stop', 'close']);
});

test('modal template and styles provide semantic controls, live status, focus, and a bounded target list', async () => {
    const componentRoot = path.resolve(
        import.meta.dirname,
        '../../web-components/modals/terminal-target-modal'
    );
    const [template, styles, source, webSkelSource] = await Promise.all([
        fs.readFile(path.join(componentRoot, 'terminal-target-modal.html'), 'utf8'),
        fs.readFile(path.join(componentRoot, 'terminal-target-modal.css'), 'utf8'),
        fs.readFile(path.join(componentRoot, 'terminal-target-modal.js'), 'utf8'),
        fs.readFile(path.resolve(import.meta.dirname, '../../webskel.json'), 'utf8'),
    ]);
    const webSkel = JSON.parse(webSkelSource);
    const registration = webSkel.components.find((component) => component.name === 'terminal-target-modal');

    assert.match(template, /role="status"[^>]*aria-live="polite"/);
    assert.match(template, /<ul[^>]*aria-label="Available terminal targets"/);
    assert.match(template, /data-local-action="closeModal"/);
    assert.match(template, /data-local-action="retryDiscovery"/);
    assert.match(template, /data-local-action="refreshTargets"/);
    assert.match(styles, /terminal-target-list[\s\S]*max-height:[\s\S]*overflow-y:\s*auto/);
    assert.match(styles, /terminal-target-button:focus-visible/);
    assert.match(source, /document\.createElement/);
    assert.match(source, /\.textContent\s*=/);
    assert.doesNotMatch(source, /\.innerHTML\s*=/);
    assert.deepEqual(registration, {
        name: 'terminal-target-modal',
        type: 'modals',
        presenterClassName: 'TerminalTargetModal',
    });
});
