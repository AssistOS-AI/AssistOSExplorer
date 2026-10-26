import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import os from 'node:os';

import { aggregateIdePlugins } from '../../utils/ide-plugins.mjs';
import { normalizeRuntimePlugins } from '../../utils/pluginUtils.core.js';
import {
    buildTerminalLaunchUrl,
    cancelTerminalTargetDiscovery,
    discoverTerminalProfileSources,
    normalizeTerminalDiscoveryPayload,
    normalizeTerminalProfilesPayload,
    openTerminalLaunchWindow,
    prepareTerminalProfile,
    readBrowserCsrfToken,
    requestTerminalProfiles,
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

function newModal(fields = {}) {
    return Object.assign(new TerminalTargetModal({ dataset: {} }, () => {}, { dir: 'projects/demo' }), fields);
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
    const modal = newModal({
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
    const modal = newModal({ element, started: true });

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

// ---------------------------------------------------------------------------------------------------------------
// Robot selection, profiled discovery and the Open flow (plan r3 section 3.3, acceptance A10).
// ---------------------------------------------------------------------------------------------------------------

const PROFILE_BASE = '/base-agent-additional-server/roboTeamAgent/3001/api/terminal-profiles';
const PROFILE_SOURCE = Object.freeze({
    agent: 'roboTeamAgent',
    id: 'roboteam-terminal-profiles',
    label: 'RoboTeam',
    contributionType: 'terminal-profile-source',
    terminalProfiles: { version: 1, base: PROFILE_BASE },
});
const ROBOTS = [{ id: 'robot-b', label: 'Robot B' }, { id: 'robot-a', label: 'Robot A' }];
const id32 = (prefix) => prefix.padEnd(32, 'x');

function profiledTargets() {
    return [
        { launch: id32('box'), kind: 'box', label: 'Ploinky Box', detail: 'Workspace runtime', access: 'rw', cwdDisplay: '/w/projects/demo' },
        { launch: id32('team'), kind: 'agent', label: 'RoboTeam', detail: 'AssistOSExplorer/roboTeamAgent', access: 'rw', cwdDisplay: '/w/projects/demo' },
        { launch: id32('expl'), kind: 'agent', label: 'Explorer', detail: 'AssistOSExplorer/explorer', access: 'rw', cwdDisplay: '/root/projects/demo' },
        { unavailable: 'home-unreachable', kind: 'agent', label: 'Isolated', detail: 'repo/isolated', access: 'rw', cwdDisplay: '/data/projects' },
        { unavailable: 'home-read-only', kind: 'agent', label: 'Mounted', detail: 'repo/mounted', access: 'ro', cwdDisplay: '/mnt/projects' },
    ];
}

function profiledPayload(profile, targets = profiledTargets(), identifier = id32('disc')) {
    return {
        ok: true,
        discovery: {
            id: identifier,
            directory: 'projects/demo',
            expiresAt: Date.now() + 300000,
            agentTargetsAvailable: true,
            ...(profile ? { profile } : {}),
            targets,
        },
    };
}

function plainTargets() {
    return profiledTargets().filter((entry) => entry.launch).map((entry) => ({ ...entry }));
}

test('profiled discovery accepts launch-less rows only with a known reason and an echoed profile', () => {
    const profile = { provider: 'roboTeamAgent', id: 'robot-a', label: 'Robot A' };
    const discovery = normalizeTerminalDiscoveryPayload(profiledPayload(profile), { profile });

    assert.deepEqual(discovery.profile, profile);
    assert.deepEqual(discovery.targets.filter((entry) => !entry.launch).map((entry) => entry.unavailable).sort(), [
        'home-read-only',
        'home-unreachable',
    ]);
    assert.ok(discovery.targets.every((entry) => entry.launch || !Object.hasOwn(entry, 'launch')));
    assert.deepEqual(Object.keys(discovery.targets.find((entry) => entry.launch)).sort(), [
        'access', 'cwdDisplay', 'detail', 'kind', 'label', 'launch',
    ]);

    const invalid = (mutate, options = { profile }) => {
        const payload = profiledPayload(profile);
        mutate(payload.discovery);
        assert.throws(() => normalizeTerminalDiscoveryPayload(payload, options), /Invalid/);
    };
    invalid((d) => { d.targets[3].unavailable = 'because'; });
    invalid((d) => { d.targets[3].launch = id32('both'); });
    invalid((d) => { delete d.targets[1].launch; });
    invalid((d) => { d.targets[1].unavailable = 'home-unreachable'; });
    invalid((d) => { d.profile = { ...profile, id: 'robot-b' }; });
    invalid((d) => { d.profile = { ...profile, provider: 'other' }; });
    invalid((d) => { d.profile = { ...profile, extra: true }; });
    invalid((d) => { delete d.profile; });
    invalid((d) => { d.extra = true; });
    invalid((d) => { d.targets[3].label = 'bad\nlabel'; });
    // A response to a plain {dir} request keeps today's exact shape: no profile and no launch-less row.
    invalid((d) => { d.profile = profile; }, {});
    assert.throws(() => normalizeTerminalDiscoveryPayload(profiledPayload(null, profiledTargets())), /Invalid terminal target availability/);
    const noBox = profiledPayload(profile, profiledTargets().slice(1));
    assert.throws(() => normalizeTerminalDiscoveryPayload(noBox, { profile }), /one Box target/);
    const duplicate = profiledPayload(profile, [profiledTargets()[0], { ...profiledTargets()[1], launch: id32('box') }]);
    assert.throws(() => normalizeTerminalDiscoveryPayload(duplicate, { profile }), /launch identifier/);
});

test('discovery posts exactly {dir} or {dir, profile:{provider,id}} and rejects a response for another robot', async (t) => {
    const previousDocument = globalThis.document;
    globalThis.document = { cookie: 'ploinky_browser_csrf=v1.proof' };
    t.after(() => { globalThis.document = previousDocument; });
    const bodies = [];
    const profile = { provider: 'roboTeamAgent', id: 'robot-a' };
    const answer = (echo) => async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return { ok: true, status: 201, json: async () => profiledPayload(echo) };
    };

    const result = await requestTerminalTargetDiscovery('projects/demo', {
        profile: { ...profile, label: 'ignored' },
        fetchImpl: answer({ ...profile, label: 'Robot A' }),
    });
    assert.equal(result.profile.label, 'Robot A');
    await requestTerminalTargetDiscovery('projects/demo', {
        fetchImpl: async (_url, options) => {
            bodies.push(JSON.parse(options.body));
            return { ok: true, status: 201, json: async () => discoveryPayload() };
        },
    });
    assert.deepEqual(bodies, [{ dir: 'projects/demo', profile }, { dir: 'projects/demo' }]);
    assert.deepEqual(Object.keys(bodies[0].profile), ['provider', 'id']);

    await assert.rejects(requestTerminalTargetDiscovery('projects/demo', {
        profile,
        fetchImpl: answer({ provider: 'roboTeamAgent', id: 'robot-b', label: 'Robot B' }),
    }), /Invalid terminal discovery profile/);
});

test('launch URL is the bare launch or attach fragment and refuses every close-policy handoff', () => {
    const launch = id32('launch');
    assert.equal(buildTerminalLaunchUrl(launch), `/webtty/#launch=${launch}`);
    assert.equal(buildTerminalLaunchUrl({ launch }), `/webtty/#launch=${launch}`);
    assert.equal(buildTerminalLaunchUrl({ attach: 'T'.repeat(32) }), `/webtty/#attach=${'T'.repeat(32)}`);
    // The launcher never carries a close policy.
    for (const handoff of [
        { launch, close: 'stop' }, { launch, close: 'keep' }, { launch, close: '' }, { launch, close: 'stop', extra: 1 },
        { attach: 'T'.repeat(32), close: 'stop' }, { close: 'stop' },
    ]) assert.throws(() => buildTerminalLaunchUrl(handoff), /Invalid/);
});

test('terminal-profile-source survives the real discovery and browser pipeline with a server-assigned agent', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-profile-sources-'));
    const invalidBases = [
        '/other/api/terminal-profiles', '/roboTeamAgent/../api', '/roboTeamAgent/%2fapi', '//evil/roboTeamAgent/api',
        '/base-agent-additional-server/roboTeamAgent/0/api', '/roboTeamAgent/api?x=1', '/roboTeamAgent//api',
    ];
    const declare = async (name, overrides) => {
        const folder = path.join(directory, 'roboTeamAgent', 'IDE-plugins', name);
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, 'config.json'), JSON.stringify({
            pluginCategory: 'application', id: name, label: 'RoboTeam', contributionType: 'terminal-profile-source',
            location: ['terminal-profiles:source'], terminalProfiles: { version: 1, base: PROFILE_BASE }, agent: 'other',
            ...overrides,
        }));
    };
    try {
        await declare('valid', {});
        await declare('plain-agent-path', { terminalProfiles: { version: 1, base: '/roboTeamAgent/api/terminal-profiles' } });
        await declare('wrong-slot', { location: ['live-sessions:source'] });
        await declare('two-slots', { location: ['terminal-profiles:source', 'file-exp:toolbar'] });
        await declare('no-label', { label: undefined });
        await declare('bad-version', { terminalProfiles: { version: 2, base: PROFILE_BASE } });
        await declare('extra-key', { terminalProfiles: { version: 1, base: PROFILE_BASE, other: true } });
        for (const [index, base] of invalidBases.entries()) {
            await declare(`bad-${index}`, { terminalProfiles: { version: 1, base } });
        }
        const catalog = await aggregateIdePlugins(directory);
        const found = catalog.application['terminal-profiles:source'];
        assert.deepEqual(found.map((entry) => entry.id).sort(), ['plain-agent-path', 'valid']);
        assert.ok(found.every((entry) => entry.agent === 'roboTeamAgent' && !entry.component && !entry.dependencies));
        assert.equal(catalog.application['live-sessions:source'], undefined);

        const runtime = normalizeRuntimePlugins(catalog).application['terminal-profiles:source'];
        assert.equal(runtime.length, 2);
        assert.ok(runtime.every((entry) => entry.contributionType === 'terminal-profile-source'
            && entry.agent === 'roboTeamAgent' && entry.runtime === true && !entry.component));
        const valid = runtime.find((entry) => entry.id === 'valid');
        for (const base of invalidBases) {
            const mutated = { ...valid, terminalProfiles: { version: 1, base } };
            assert.equal(normalizeRuntimePlugins({ application: { 'terminal-profiles:source': [mutated] } })
                .application['terminal-profiles:source'].length, 0, base);
        }
        assert.equal(normalizeRuntimePlugins({ application: { 'terminal-profiles:source': [{ ...valid, agent: 'dpuAgent' }] } })
            .application['terminal-profiles:source'].length, 0, 'the base must name the entry agent');
        assert.equal(normalizeRuntimePlugins({ application: { 'file-exp:toolbar': [valid] } })
            .application['file-exp:toolbar'].length, 0, 'a source is valid only in its own slot');
        assert.equal(normalizeRuntimePlugins({ application: { 'terminal-profiles:source': [{ ...valid, id: ['valid'] }] } })
            .application['terminal-profiles:source'].length, 0);

        const sources = discoverTerminalProfileSources({
            'terminal-profiles:source': [...runtime, valid, { ...valid, contributionType: 'mount' }],
        });
        assert.deepEqual(sources.map((entry) => [entry.agent, entry.label, entry.base]).sort(), [
            ['roboTeamAgent', 'RoboTeam', PROFILE_BASE],
            ['roboTeamAgent', 'RoboTeam', '/roboTeamAgent/api/terminal-profiles'],
        ]);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('profile list and prepare use the declared base, the mutation proof, and exact response shapes', async (t) => {
    const previousDocument = globalThis.document;
    globalThis.document = { cookie: 'ploinky_browser_csrf=v1.prepare-proof' };
    t.after(() => { globalThis.document = previousDocument; });
    const source = discoverTerminalProfileSources({ 'terminal-profiles:source': [PROFILE_SOURCE] })[0];
    assert.equal(source.base, PROFILE_BASE);

    const calls = [];
    const profiles = await requestTerminalProfiles(source, {
        fetchImpl: async (url, options) => {
            calls.push([url, options.method, options.credentials, options.cache]);
            return { ok: true, status: 200, json: async () => ({ ok: true, profiles: ROBOTS }) };
        },
    });
    assert.deepEqual(profiles.map((entry) => entry.id), ['robot-b', 'robot-a']);
    assert.deepEqual(calls, [[PROFILE_BASE, 'GET', 'same-origin', 'no-store']]);

    for (const payload of [
        { ok: true, profiles: [{ id: 'bad id', label: 'x' }] }, { ok: true, profiles: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] },
        { ok: true, profiles: [{ id: 'a', label: 'x', home: '/h' }] }, { ok: true, profiles: [{ id: 'a', label: 'x\ny' }] },
        { ok: false, profiles: [] }, { ok: true, profiles: [], extra: 1 }, { ok: true },
        { ok: true, profiles: Array.from({ length: 257 }, (_, index) => ({ id: `r${index}`, label: 'x' })) },
    ]) assert.throws(() => normalizeTerminalProfilesPayload(payload), /Invalid/);

    const prepareCalls = [];
    const prepared = await prepareTerminalProfile(source, 'robot-a', {
        fetchImpl: async (url, options) => {
            prepareCalls.push({ url, options });
            return { ok: true, status: 200, json: async () => ({ ok: true, id: 'robot-a', label: 'Robot A', root: '.data/roboTeamAgent/robots/robot-a' }) };
        },
    });
    assert.equal(prepared.root, '.data/roboTeamAgent/robots/robot-a');
    assert.equal(prepareCalls[0].url, `${PROFILE_BASE}/robot-a/prepare`);
    assert.equal(prepareCalls[0].options.method, 'POST');
    assert.equal(prepareCalls[0].options.credentials, 'same-origin');
    assert.equal(prepareCalls[0].options.headers['X-Ploinky-Browser-CSRF-Token'], 'v1.prepare-proof');
    assert.equal(prepareCalls[0].options.body, '{}');

    for (const body of [
        { ok: true, id: 'robot-b', label: 'Robot A', root: '.data/x' }, { ok: true, id: 'robot-a', label: 'Robot A' },
        { ok: true, id: 'robot-a', label: 'Robot A', root: '.data/x', extra: 1 }, { ok: false, id: 'robot-a', label: 'Robot A', root: '.data/x' },
        { ok: true, id: 'robot-a', label: 'Robot A', root: '' },
    ]) {
        await assert.rejects(prepareTerminalProfile(source, 'robot-a', {
            fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
        }), /invalid/i);
    }
    await assert.rejects(prepareTerminalProfile(source, '../escape', { fetchImpl: async () => { throw new Error('unreachable'); } }), /Invalid/);
    await assert.rejects(prepareTerminalProfile(source, 'robot-a', {
        fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false }) }),
    }), (error) => error.status === 403);
});

// A fake page: a real TerminalTargetModal over fake elements, a scripted fetch, a popup log and a modal-close log.
function pageHarness(t, { sources = [PROFILE_SOURCE], robots = ROBOTS, respond = null, windowRef = null } = {}) {
    const previous = new Map(['document', 'assistOS', 'fetch', 'window', 'sessionStorage', 'localStorage'].map((key) => [key, globalThis[key]]));
    t.after(() => { for (const [key, value] of previous) globalThis[key] = value; });
    const log = [];
    let discoveries = 0;
    const storageWrites = [];
    globalThis.sessionStorage = { setItem: (...args) => storageWrites.push(args), getItem: () => null };
    globalThis.localStorage = globalThis.sessionStorage;
    globalThis.document = {
        cookie: 'ploinky_browser_csrf=v1.page-proof',
        createElement: (tagName) => new FakeElement(tagName),
        createDocumentFragment: () => new FakeElement('#fragment', { fragment: true }),
    };
    globalThis.assistOS = {
        workspace: { appPlugins: { 'terminal-profiles:source': sources } },
        UI: { closeModal: (element) => log.push(['closeModal', element.id]) },
    };
    globalThis.fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        const body = options.body === undefined ? undefined : options.body;
        log.push(['fetch', method, url, body]);
        const custom = respond ? await respond({ url, method, body, options, log }) : undefined;
        if (custom) return { ok: (custom.status || 200) < 400, status: custom.status || 200, json: async () => custom.body };
        if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true }) };
        if (method === 'GET') return { ok: true, status: 200, json: async () => ({ ok: true, profiles: robots }) };
        if (url === '/webtty/target-discoveries') {
            discoveries += 1;
            const request = JSON.parse(body);
            const robot = request.profile && robots.find((entry) => entry.id === request.profile.id);
            const profile = robot ? { provider: request.profile.provider, id: robot.id, label: robot.label } : null;
            return {
                ok: true,
                status: 201,
                json: async () => profiledPayload(profile, profile ? profiledTargets() : plainTargets(), id32(`disc${discoveries}`)),
            };
        }
        const prepared = /\/([^/]+)\/prepare$/.exec(url);
        return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, id: prepared[1], label: 'Robot', root: `.data/roboTeamAgent/robots/${prepared[1]}` }),
        };
    };
    const popups = [];
    globalThis.window = windowRef || {
        open(...args) {
            const popup = {
                opener: {},
                closed: false,
                close() { this.closed = true; log.push(['popup-close']); },
                document: {
                    createElement() {
                        const anchor = { click() { log.push(['navigate', anchor.href, anchor.rel, anchor.referrerPolicy]); } };
                        return anchor;
                    },
                    body: { appendChild() {} },
                },
            };
            popups.push(popup);
            log.push(['popup-open', ...args]);
            return popup;
        },
    };
    const names = ['Directory', 'Status', 'Warning', 'Notice', 'List', 'Retry', 'Refresh', 'RobotNote', 'Disclosure', 'Open'];
    const fields = new Map(names.map((name) => [`#terminalTarget${name}`, new FakeElement(name === 'List' ? 'ul' : 'div')]));
    const select = new FakeElement('select');
    select.value = '';
    fields.set('#terminalTargetRobot', select);
    const element = {
        id: 'modal',
        dataset: {},
        closest: () => null,
        querySelector: (selector) => fields.get(selector),
        querySelectorAll: () => [],
        addEventListener(type) { log.push(['listen', type]); },
        removeEventListener() {},
    };
    const modal = new TerminalTargetModal(element, () => {}, { dir: 'projects/demo' });
    t.after(() => modal.afterUnload());
    const $ = (name) => fields.get(`#terminalTarget${name}`);
    const settle = async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
    const optionTexts = () => select.children.map((option) => option.textContent);
    const rows = () => $('List').children.map((item) => item.children[0]);
    const chooseRobot = async (label) => {
        const option = select.children.find((candidate) => candidate.textContent === label);
        assert.ok(option, `option ${label}`);
        select.value = option.value;
        modal.handleChange({ target: { id: 'terminalTargetRobot', value: option.value } });
        await settle();
    };
    const chooseRow = async (labelPattern) => {
        const button = rows().find((candidate) => labelPattern.test(textTree(candidate)));
        assert.ok(button, String(labelPattern));
        assert.equal(button.disabled, false);
        assert.equal(modal.selectTarget(button), true);
        await settle();
    };
    return { modal, log, popups, storageWrites, $, settle, optionTexts, rows, chooseRobot, chooseRow, select, fields };
}

const fetchLog = (log, method) => log.filter((entry) => entry[0] === 'fetch' && (!method || entry[1] === method));

test('dialog starts with no robot, a placeholder only, discovery for {dir} and every row disabled', async (t) => {
    const page = pageHarness(t);
    page.modal.afterRender();
    await page.settle();

    assert.equal(page.select.value, '');
    assert.deepEqual(page.optionTexts(), ['Choose a robot', 'Robot A', 'Robot B']);
    assert.ok(page.optionTexts().every((text) => !/no robot/i.test(text)));
    assert.equal(page.select.children[0].disabled, true);
    assert.equal(page.select.children[0].selected, true);
    assert.equal(page.select.disabled, false);
    assert.equal(page.$('Open').disabled, true);
    assert.equal(page.modal.selectedRobotKey, '');
    assert.deepEqual(fetchLog(page.log, 'POST').map((entry) => JSON.parse(entry[3])), [{ dir: 'projects/demo' }]);
    assert.deepEqual(fetchLog(page.log, 'GET').map((entry) => entry[2]), [PROFILE_BASE]);

    // A plain {dir} discovery carries a launch on every row, and each one is shown disabled.
    const rows = page.rows();
    assert.equal(rows.length, 3);
    for (const row of rows) {
        assert.equal(row.disabled, true);
        assert.match(textTree(row), /Choose a robot first/);
    }
    assert.equal(page.modal.targetsByLaunch.size, 3);
    assert.match(textTree(page.$('Status')), /Choose a robot/);
    assert.equal(page.modal.selectTarget({ dataset: { launch: id32('box') } }), false);
    assert.equal(page.modal.selectedLaunch, '');
    assert.equal(await page.modal.openTerminal(), false);
    assert.equal(fetchLog(page.log, 'POST').length, 1, 'Open without a robot sends nothing');
    assert.deepEqual(page.log.filter((entry) => entry[0] === 'popup-open'), []);
});

test('choosing a robot cancels the plain discovery, discovers for that robot, and gates Open on an enabled row', async (t) => {
    const page = pageHarness(t);
    page.modal.afterRender();
    await page.settle();
    const plainDiscoveryId = page.modal.discoveryId;
    assert.equal(plainDiscoveryId, id32('disc1'));

    await page.chooseRobot('Robot A');

    const calls = page.log.filter((entry) => entry[0] === 'fetch' && entry[1] !== 'GET').map((entry) => [entry[1], entry[2], entry[3]]);
    assert.deepEqual(calls, [
        ['POST', '/webtty/target-discoveries', JSON.stringify({ dir: 'projects/demo' })],
        ['DELETE', `/webtty/target-discoveries/${plainDiscoveryId}`, undefined],
        ['POST', '/webtty/target-discoveries', JSON.stringify({ dir: 'projects/demo', profile: { provider: 'roboTeamAgent', id: 'robot-a' } })],
    ]);
    assert.equal(page.modal.discoveryId, id32('disc2'));
    assert.deepEqual(page.modal.currentDiscovery.profile, { provider: 'roboTeamAgent', id: 'robot-a', label: 'Robot A' });

    const byLabel = Object.fromEntries(page.rows().map((row) => [row.children[0].children[0].textContent, row]));
    assert.equal(byLabel['Ploinky Box'].disabled, false);
    assert.equal(byLabel.RoboTeam.disabled, false);
    assert.equal(byLabel.Explorer.disabled, false);
    assert.equal(byLabel.Isolated.disabled, true);
    assert.match(textTree(byLabel.Isolated), /This container cannot see Robot A's home folder/);
    assert.equal(byLabel.Mounted.disabled, true);
    assert.match(textTree(byLabel.Mounted), /This container can only read Robot A's home folder/);
    assert.equal(byLabel.Isolated.dataset.launch, undefined);
    assert.equal(page.modal.selectTarget(byLabel.Isolated), false, 'a launch-less row can never be chosen');
    assert.equal(page.$('Open').disabled, true, 'a robot alone does not enable Open');

    await page.chooseRow(/Ploinky Box/);
    assert.equal(page.$('Open').disabled, false);
    assert.equal(page.modal.selectedLaunch, id32('box'));
});

test('changing the robot cancels the previous discovery, clears the chosen row and discards a late stale response', async (t) => {
    let releaseSecond;
    const page = pageHarness(t, {
        respond: async ({ url, method, body }) => {
            if (url !== '/webtty/target-discoveries' || method !== 'POST' || JSON.parse(body).profile?.id !== 'robot-a') return null;
            await new Promise((resolve) => { releaseSecond = resolve; });
            return null;
        },
    });
    page.modal.afterRender();
    await page.settle();
    await page.chooseRobot('Robot B');
    await page.chooseRow(/Ploinky Box/);
    assert.equal(page.$('Open').disabled, false);

    // Robot A's discovery is held in flight while the user switches to Robot B again.
    await page.chooseRobot('Robot A');
    assert.equal(page.$('Open').disabled, true);
    assert.equal(page.modal.selectedLaunch, '');
    assert.equal(page.rows().length, 0, 'rows of the previous robot are gone while discovering');
    const heldDiscoveries = fetchLog(page.log, 'POST').filter((entry) => JSON.parse(entry[3]).profile?.id === 'robot-a');
    assert.equal(heldDiscoveries.length, 1);
    await page.chooseRobot('Robot B');
    releaseSecond();
    await page.settle();

    const posts = fetchLog(page.log, 'POST').map((entry) => JSON.parse(entry[3]).profile?.id || null);
    assert.deepEqual(posts, [null, 'robot-b', 'robot-a', 'robot-b']);
    assert.equal(page.modal.currentDiscovery.profile.id, 'robot-b');
    assert.equal(page.$('Open').disabled, true, 'a fresh discovery needs a fresh row choice');
    // Every discovery that is not the live one was cancelled, including the response that arrived late.
    const cancelled = fetchLog(page.log, 'DELETE').map((entry) => entry[2].split('/').pop());
    // disc1 is the plain one, disc2 Robot B's first, disc3 the live Robot B one, disc4 the late Robot A response.
    for (const identifier of [id32('disc1'), id32('disc2'), id32('disc4')]) {
        assert.ok(cancelled.includes(identifier), `${identifier} cancelled`);
    }
    assert.equal(page.modal.discoveryId, id32('disc3'));
    assert.ok(!cancelled.includes(page.modal.discoveryId));
});

test('the HOME disclosure names the robot and adds the Box and non-RoboTeam sentences for the chosen row', async (t) => {
    const page = pageHarness(t);
    page.modal.afterRender();
    await page.settle();
    assert.equal(page.$('Disclosure').hidden, true);

    await page.chooseRobot('Robot A');
    const base = "HOME will be Robot A's home folder. Settings the robot wrote there (git, ssh, coding-agent configuration) can run commands when you use those tools here, and logins, history and files you create there are stored where the robot can read them.";
    const box = 'The Box runs the Ploinky router and controls every agent container.';
    const toolSetup = "The robot's tool setup is not loaded here.";
    const sentences = () => page.$('Disclosure').children.map((child) => child.textContent);
    assert.equal(page.$('Disclosure').hidden, false);
    assert.deepEqual(sentences(), [base]);

    await page.chooseRow(/Ploinky Box/);
    assert.deepEqual(sentences(), [base, box, toolSetup]);
    await page.chooseRow(/Explorer/);
    assert.deepEqual(sentences(), [base, toolSetup]);
    await page.chooseRow(/RoboTeam/);
    assert.deepEqual(sentences(), [base], 'the declaring agent loads the robot tool setup');
});

test('Open is disabled with a reason when no source, a failing source or no robots is available, and the list stays visible', async (t) => {
    const none = pageHarness(t, { sources: [] });
    none.modal.afterRender();
    await none.settle();
    assert.equal(none.$('RobotNote').textContent, 'RoboTeam is not available.');
    assert.equal(none.$('RobotNote').hidden, false);
    assert.equal(none.select.disabled, true);
    assert.equal(none.$('Open').disabled, true);
    assert.equal(none.rows().length, 3);
    assert.ok(none.rows().every((row) => row.disabled));
    assert.deepEqual(fetchLog(none.log, 'GET'), []);

    const empty = pageHarness(t, { robots: [] });
    empty.modal.afterRender();
    await empty.settle();
    assert.equal(empty.$('RobotNote').textContent, 'No robots exist yet: create one in RoboTeam.');
    assert.equal(empty.select.disabled, true);
    assert.equal(empty.$('Open').disabled, true);
    assert.equal(empty.rows().length, 3);

    const failing = pageHarness(t, {
        respond: async ({ method }) => (method === 'GET' ? { status: 500, body: { ok: false } } : null),
    });
    failing.modal.afterRender();
    await failing.settle();
    assert.equal(failing.$('RobotNote').textContent, 'RoboTeam: robots could not be loaded.');
    assert.equal(failing.select.disabled, true);
    assert.equal(failing.$('Open').disabled, true);
    assert.equal(failing.rows().length, 3);
});

test('robots come from every declared source, labelled with the source only when several exist', async (t) => {
    const second = {
        ...PROFILE_SOURCE, agent: 'dpuAgent', id: 'dpu-profiles', label: 'DPU',
        terminalProfiles: { version: 1, base: '/dpuAgent/api/terminal-profiles' },
    };
    const lists = { [PROFILE_BASE]: [{ id: 'robot-a', label: 'Robot A' }], '/dpuAgent/api/terminal-profiles': [{ id: 'robot-a', label: 'Robot A' }, { id: 'zed', label: 'Zed' }] };
    const page = pageHarness(t, {
        sources: [PROFILE_SOURCE, second],
        respond: async ({ url, method }) => (method === 'GET' ? { body: { ok: true, profiles: lists[url] } } : null),
    });
    page.modal.afterRender();
    await page.settle();
    assert.deepEqual(page.optionTexts(), ['Choose a robot', 'Robot A (DPU)', 'Robot A (RoboTeam)', 'Zed (DPU)']);
    const values = page.select.children.slice(1).map((option) => option.value);
    assert.equal(new Set(values).size, 3, 'the same id from two sources stays distinguishable');

    // The discovery request names the declaring agent of the chosen source.
    await page.chooseRobot('Robot A (DPU)');
    const body = JSON.parse(fetchLog(page.log, 'POST').at(-1)[3]);
    assert.deepEqual(body.profile, { provider: 'dpuAgent', id: 'robot-a' });
});

test('the chooser has no close policy: every open navigates to a bare launch fragment and persists nothing', async (t) => {
    for (const staleChange of [null, { name: 'terminalTargetClosePolicy', value: 'stop' }]) {
        const page = pageHarness(t);
        page.modal.afterRender();
        await page.settle();
        assert.equal(Object.hasOwn(page.modal, 'closePolicy'), false, 'the dialog holds no close policy');
        await page.chooseRobot('Robot A');
        await page.chooseRow(/Ploinky Box/);
        // A leftover policy control event from an older page must not change the launch.
        if (staleChange) page.modal.handleChange({ target: staleChange });

        assert.equal(await page.modal.openTerminal(), true);
        const navigation = page.log.find((entry) => entry[0] === 'navigate');
        assert.equal(navigation[1], `/webtty/#launch=${id32('box')}`);
        assert.equal(navigation[2], 'noopener noreferrer');
        assert.equal(navigation[3], 'no-referrer');
        assert.deepEqual(page.storageWrites, []);
        assert.equal(page.modal.handedOff, true);
        assert.deepEqual(page.log.filter((entry) => entry[0] === 'closeModal'), [['closeModal', 'modal']]);
    }
});

test('Open reserves the isolated tab before the prepare request, then navigates; the handed-off launch is not cancelled', async (t) => {
    const page = pageHarness(t);
    page.modal.afterRender();
    await page.settle();
    await page.chooseRobot('Robot B');
    await page.chooseRow(/Explorer/);

    assert.equal(await page.modal.openTerminal(), true);
    const order = page.log.map((entry) => entry[0] === 'fetch' ? `${entry[1]} ${entry[2]}` : entry[0]);
    const open = order.indexOf('popup-open');
    const prepare = order.indexOf(`POST ${PROFILE_BASE}/robot-b/prepare`);
    const navigate = order.indexOf('navigate');
    assert.ok(open > 0 && prepare > open && navigate > prepare, order.join(' | '));
    assert.deepEqual(page.log.find((entry) => entry[0] === 'popup-open').slice(1), ['about:blank', '_blank']);
    assert.equal(page.log.find((entry) => entry[2] === `${PROFILE_BASE}/robot-b/prepare`)[3], '{}');
    // afterUnload after a hand-off must leave the consumed discovery to the new tab.
    const deletesBefore = fetchLog(page.log, 'DELETE').length;
    await page.modal.afterUnload();
    assert.equal(fetchLog(page.log, 'DELETE').length, deletesBefore);
});

test('a blocked popup sends no prepare request and a failed prepare closes the reserved tab and keeps the dialog', async (t) => {
    const blocked = pageHarness(t, { windowRef: { open: () => null } });
    blocked.modal.afterRender();
    await blocked.settle();
    await blocked.chooseRobot('Robot A');
    await blocked.chooseRow(/Ploinky Box/);
    assert.equal(await blocked.modal.openTerminal(), false);
    assert.match(blocked.$('Warning').textContent, /Allow popups/);
    assert.equal(blocked.$('Status').textContent, 'No terminal was opened.');
    assert.equal(blocked.modal.handedOff, false);
    assert.equal(blocked.$('Open').disabled, false);
    assert.ok(!blocked.log.some((entry) => String(entry[2]).endsWith('/prepare')));

    const failing = pageHarness(t, {
        respond: async ({ url }) => (url.endsWith('/prepare') ? { status: 500, body: { ok: false } } : null),
    });
    failing.modal.afterRender();
    await failing.settle();
    await failing.chooseRobot('Robot A');
    await failing.chooseRow(/Ploinky Box/);
    assert.equal(await failing.modal.openTerminal(), false);
    assert.equal(failing.popups[0].closed, true);
    assert.equal(failing.modal.handedOff, false);
    assert.equal(failing.modal.opening, false);
    assert.equal(failing.$('Warning').textContent, 'Robot A could not be prepared. No terminal was opened.');
    assert.equal(failing.$('Warning').hidden, false);
    assert.ok(!failing.log.some((entry) => entry[0] === 'navigate' || entry[0] === 'closeModal'));
    assert.equal(failing.$('Open').disabled, false, 'the user can try again with the same choice');
});

test('closing the dialog while the robot is being prepared closes the reserved tab and never navigates it', async (t) => {
    let release;
    const page = pageHarness(t, {
        respond: async ({ url }) => {
            if (url.endsWith('/prepare')) await new Promise((resolve) => { release = resolve; });
            return null;
        },
    });
    page.modal.afterRender();
    await page.settle();
    await page.chooseRobot('Robot A');
    await page.chooseRow(/Ploinky Box/);
    const opening = page.modal.openTerminal();
    await page.settle();
    assert.equal(page.modal.opening, true);
    assert.equal(page.$('Open').disabled, true);
    assert.equal(page.select.disabled, true, 'the robot cannot change while it is being prepared');
    assert.equal(page.modal.chooseRobot(page.select.children[2].value), false);
    assert.equal(page.modal.selectTarget({ dataset: { launch: id32('team') } }), false);
    assert.match(page.$('Status').textContent, /Preparing Robot A/);

    page.modal.closeModal();
    release();
    assert.equal(await opening, false);
    assert.equal(page.popups[0].closed, true);
    assert.equal(page.modal.handedOff, false);
    assert.ok(!page.log.some((entry) => entry[0] === 'navigate'));
});

test('Open stays disabled for an expired discovery and a discovery that belongs to another robot', async (t) => {
    const page = pageHarness(t);
    page.modal.afterRender();
    await page.settle();
    await page.chooseRobot('Robot A');
    await page.chooseRow(/Ploinky Box/);
    assert.ok(page.modal.openGate());

    const discovery = page.modal.currentDiscovery;
    page.modal.currentDiscovery = { ...discovery, expiresAt: Date.now() - 1 };
    assert.equal(page.modal.openGate(), null);
    page.modal.currentDiscovery = { ...discovery, profile: { ...discovery.profile, id: 'robot-b' } };
    assert.equal(page.modal.openGate(), null);
    page.modal.currentDiscovery = { ...discovery, profile: undefined };
    assert.equal(page.modal.openGate(), null);
    page.modal.currentDiscovery = discovery;
    assert.ok(page.modal.openGate());
    assert.equal(await page.modal.openTerminal.call({ ...page.modal, openGate: () => null, statusElement: { textContent: '' } }), false);
});

test('template and styles carry the robot select and the Open button, and no close policy control or text', async () => {
    const root = path.resolve(import.meta.dirname, '../../web-components/modals/terminal-target-modal');
    const [template, styles, source] = await Promise.all(['html', 'css', 'js'].map((extension) => (
        fs.readFile(path.join(root, `terminal-target-modal.${extension}`), 'utf8'))));

    assert.match(template, /<select id="terminalTargetRobot"[^>]*\brequired\b/);
    assert.match(template, /<option value="" disabled selected>Choose a robot<\/option>/);
    assert.doesNotMatch(template, /No robot/i);
    assert.match(template, /data-local-action="openTerminal"[^>]*disabled/);
    // The chooser shows and sends no close policy.
    assert.doesNotMatch(template, /terminalTargetClosePolicy|<fieldset|<legend|type="radio"/);
    assert.doesNotMatch(template, /When this tab closes|Keep running|Stop it/);
    assert.doesNotMatch(styles, /terminal-target-policy/);
    assert.doesNotMatch(source, /CLOSE_POLICIES|closePolicy|terminalTargetClosePolicy|close=stop/);
    assert.doesNotMatch(template, /Closing the tab keeps the terminal running/);
    assert.match(styles, /terminal-target-button:disabled/);
    assert.match(styles, /terminal-target-select/);
    assert.doesNotMatch(source, /\.innerHTML\s*=|localStorage|sessionStorage/);
});

test('choices that expire while the robot is being prepared are not launched; the dialog refreshes them', async (t) => {
    let release;
    const page = pageHarness(t, {
        respond: async ({ url }) => {
            if (url.endsWith('/prepare')) await new Promise((resolve) => { release = resolve; });
            return null;
        },
    });
    page.modal.afterRender();
    await page.settle();
    await page.chooseRobot('Robot A');
    await page.chooseRow(/Ploinky Box/);
    const opening = page.modal.openTerminal();
    await page.settle();
    page.modal.discoveryExpiresAt = Date.now() - 1;
    release();
    assert.equal(await opening, false);
    await page.settle();
    assert.equal(page.popups[0].closed, true);
    assert.ok(!page.log.some((entry) => entry[0] === 'navigate'));
    assert.equal(page.modal.handedOff, false);
    assert.equal(fetchLog(page.log, 'POST').filter((entry) => entry[2] === '/webtty/target-discoveries').length, 3, 'a fresh discovery replaced the expired one');
});

function heldPrepare(t) {
    const hold = { release: null };
    const page = pageHarness(t, {
        respond: async ({ url }) => {
            if (url.endsWith('/prepare')) await new Promise((resolve) => { hold.release = resolve; });
            return null;
        },
    });
    return { page, hold };
}

test('Refresh and Retry are disabled and inert while the robot is being prepared, and Open still uses its own launch', async (t) => {
    const { page, hold } = heldPrepare(t);
    page.modal.afterRender();
    await page.settle();
    await page.chooseRobot('Robot A');
    await page.chooseRow(/Ploinky Box/);
    assert.equal(page.$('Refresh').disabled, false);
    const discoveryId = page.modal.discoveryId;

    const opening = page.modal.openTerminal();
    await page.settle();
    assert.equal(page.modal.opening, true);
    assert.equal(page.$('Refresh').disabled, true);
    assert.equal(page.$('Retry').disabled, true);
    const requestsBefore = page.log.filter((entry) => entry[0] === 'fetch').length;
    await page.modal.refreshTargets();
    await page.modal.retryDiscovery();
    assert.equal(page.log.filter((entry) => entry[0] === 'fetch').length, requestsBefore, 'no cancel and no new discovery');
    assert.equal(page.modal.discoveryId, discoveryId);

    hold.release();
    assert.equal(await opening, true);
    assert.equal(page.log.find((entry) => entry[0] === 'navigate')[1], `/webtty/#launch=${id32('box')}`);
});

test('a discovery replaced while the robot is prepared voids the launch: no navigation, tab closed, message shown, replacement cancelled on close', async (t) => {
    const { page, hold } = heldPrepare(t);
    page.modal.afterRender();
    await page.settle();
    await page.chooseRobot('Robot A');
    await page.chooseRow(/Ploinky Box/);
    const original = page.modal.discoveryId;

    const opening = page.modal.openTerminal();
    await page.settle();
    // Replace the discovery through the refresh path itself, as the review scenario does. The guard that blocks the
    // click is lifted only for this call so the defence behind it is exercised.
    page.modal.opening = false;
    await page.modal.refreshTargets();
    page.modal.opening = true;
    const replacement = page.modal.discoveryId;
    assert.notEqual(replacement, original);
    assert.ok(fetchLog(page.log, 'DELETE').some((entry) => entry[2].endsWith(original)), 'the first discovery was cancelled');

    hold.release();
    assert.equal(await opening, false);
    await page.settle();
    assert.ok(!page.log.some((entry) => entry[0] === 'navigate'), 'a launch from a cancelled discovery is never navigated');
    assert.equal(page.popups[0].closed, true);
    assert.equal(page.modal.handedOff, false);
    assert.equal(page.$('Warning').textContent, 'These terminal choices changed while the robot was being prepared. Choose again.');
    assert.equal(page.$('Warning').hidden, false);
    assert.equal(page.$('Status').textContent, 'No terminal was opened.');
    assert.ok(!page.log.some((entry) => entry[0] === 'closeModal'), 'the dialog stays open');
    assert.equal(page.$('Refresh').disabled, false, 'the controls come back once Open is no longer preparing');
    assert.equal(page.$('Open').disabled, true, 'the old row choice no longer exists');
    assert.equal(page.modal.discoveryId, replacement);

    // Closing the dialog afterwards cancels the replacement, because nothing was handed off.
    const before = fetchLog(page.log, 'DELETE').length;
    page.modal.closeModal();
    await page.settle();
    const deletes = fetchLog(page.log, 'DELETE').slice(before).map((entry) => entry[2].split('/').pop());
    assert.deepEqual(deletes, [replacement]);
});
