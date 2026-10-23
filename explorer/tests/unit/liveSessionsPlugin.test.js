import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aggregateIdePlugins } from '../../utils/ide-plugins.mjs';
import { normalizeRuntimePlugins } from '../../utils/pluginUtils.core.js';
import { openExpandedModal } from '../../shared/ui/expanded-modal.js';
import { LiveSessionsToolButton } from '../../IDE-plugins/live-sessions/live-sessions-tool-button.js';
import { LiveSessionsModal } from '../../IDE-plugins/live-sessions/components/live-sessions-modal/live-sessions-modal.js';
import {
    aggregateLiveSessions, killLiveSession, listLiveSessions, listLiveSessionsDetailed, mintLiveSessionAttach,
    normalizeAgentSessionsPayload, normalizeLiveSessionsPayload, parseLiveSessionsPayload, sendLiveSessionCloseIntent,
    setLiveSessionClosePolicy,
} from '../../IDE-plugins/live-sessions/live-sessions-api.js';
import {
    clearEmbeddedTerminalKey, countNeedsAttention, currentCue, EMBEDDED_TERMINAL_KEY, publishCue,
    readEmbeddedTerminalKey, writeEmbeddedTerminalKey,
} from '../../IDE-plugins/live-sessions/live-sessions-state.js';
import {
    CUE_MESSAGE, hostWindow, installHostBridge, parseBridgeMessage, postCueToHost, postViewToHost, VIEW_MESSAGE as BRIDGE_VIEW_MESSAGE,
} from '../../IDE-plugins/live-sessions/live-sessions-bridge.js';
import { closePolicyStatusText, closureText } from '../../IDE-plugins/live-sessions/components/live-sessions-modal/live-sessions-modal.js';

const ID = 'S'.repeat(32);
const TOKEN = 'T'.repeat(32);
const root = path.resolve(import.meta.dirname, '../..');
// What the host forwards to the toolbar presenter as `pluginToolbarModal`: config.json's descriptor.
const PAGE_URL = '/explorer/IDE-plugins/live-sessions/live-sessions-page.html';
const PAGE_DESCRIPTOR = Object.freeze({ mode: 'iframe', url: PAGE_URL, readyTitle: 'Live Sessions', fullscreen: true });
const HOST_CONTEXT = Object.freeze({ pluginLabel: 'Live Sessions', pluginToolbarModal: PAGE_DESCRIPTOR });

function row(overrides = {}) {
    return {
        id: ID, source: 'webtty', kind: 'shell', title: '<img onerror=bad>', detail: 'Workspace runtime',
        cwdDisplay: '/project', access: 'rw', status: 'detached', isOwner: true,
        ownerLabel: 'Admin', viewerCount: 0, startedAt: 1000, lastActivityAt: 2000,
        capabilities: { watch: true, input: true, stop: true, message: false }, attach: { mode: 'webtty' },
        ...overrides,
    };
}

function payload(rows = [row()]) { return { ok: true, version: 1, sessions: rows }; }
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return body; } }; }

class Element {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.children = [];
        this.dataset = {};
        this.textContent = '';
        this.isConnected = true;
    }
    appendChild(child) {
        this.children.push(...(child.tagName === '#fragment' ? child.children : [child]));
        return child;
    }
    replaceChildren(...children) { this.children = children.flatMap((child) => child.tagName === '#fragment' ? child.children : [child]); }
    addEventListener() {}
    removeEventListener() {}
    setAttribute(key, value) { this[key] = value; }
    getAttribute() { return ''; }
    querySelector() { return null; }
    focus() {}
}

function environment(t, { admin = true } = {}) {
    const previous = new Map(['document', 'assistOS', 'fetch', 'window', 'sessionStorage', 'localStorage'].map((key) => [key, globalThis[key]]));
    t.after(() => { for (const [key, value] of previous) globalThis[key] = value; });
    globalThis.document = {
        cookie: '',
        createElement: (tag) => new Element(tag),
        createDocumentFragment: () => new Element('#fragment'),
    };
    globalThis.assistOS = { user: { roles: admin ? ['admin'] : ['user'] } };
    const elements = new Map(['Status', 'List', 'Viewer', 'ViewerTitle', 'Frame'].map((name) => [`#liveSessions${name}`, new Element()]));
    const host = new Element();
    host.querySelector = (selector) => elements.get(selector);
    const modal = new LiveSessionsModal(host, () => {});
    t.after(() => modal.afterUnload());
    return { modal, elements };
}

test('Live Sessions survives real discovery and normalization as an authenticated toolbar component', async () => {
    const config = JSON.parse(await fs.readFile(path.join(root, 'IDE-plugins/live-sessions/config.json'), 'utf8'));
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.applicationPlugins['live-sessions'], true);
    assert.equal(config.adminOnly, false);
    assert.equal(config.locationOrder, 380);
    // Like RoboTeam and Soul Gateway, the panel is a page in the shared expanded modal's iframe.
    assert.deepEqual(config.toolbarModal, PAGE_DESCRIPTOR);
    const catalog = normalizeRuntimePlugins(await aggregateIdePlugins(path.resolve(root, '..')));
    const plugin = catalog.application['file-exp:toolbar'].find((entry) => entry.id === 'live-sessions');
    assert.ok(plugin);
    assert.equal(plugin.agent, 'explorer');
    assert.equal(plugin.component, 'live-sessions-tool-button');
    assert.equal(plugin.dependencies[0].component, 'live-sessions-modal');
    assert.deepEqual(plugin.dependencies.map((dependency) => dependency.component), ['live-sessions-modal', 'live-session-stream-view'],
        'the page registers both components through the runtime plugin catalog');
    assert.deepEqual(plugin.toolbarModal, PAGE_DESCRIPTOR, 'the descriptor survives discovery and browser normalization');
    assert.equal(plugin.adminOnly, false);
    assert.equal(config.mountOnStart, true);
    assert.equal(plugin.mountOnStart, true, 'the opt-in survives discovery and browser normalization');
    // The toolbar button and the panel are loaded from different URLs; the shared state module must resolve to one instance.
    assert.equal(
        new URL('./live-sessions-state.js', `https://explorer.test${plugin.componentBaseUrl}.js`).href,
        new URL('../../live-sessions-state.js', `https://explorer.test${plugin.dependencies[0].baseUrl}.js`).href,
    );
    assert.equal(
        new URL('./live-sessions-state.js', `https://explorer.test${plugin.componentBaseUrl}.js`).pathname,
        '/workspace-files/explorer/IDE-plugins/live-sessions/live-sessions-state.js',
    );
});

test('strict shell normalizer rejects unknown keys, kinds, capabilities, duplicate IDs and unsafe text', () => {
    assert.equal(normalizeLiveSessionsPayload(payload())[0].title, '<img onerror=bad>');
    for (const overrides of [
        { containerId: 'private' }, { principal: 'private' }, { kind: 'robot-task' }, { source: 'agent' },
        { status: 'running' }, { access: 'root' }, { title: 'bad\nlabel' }, { id: '../escape' },
        { capabilities: { ...row().capabilities, input: false } },
        { capabilities: { ...row().capabilities, secret: true } }, { attach: { mode: 'webtty', token: TOKEN } },
        { endedAt: 3000 }, { viewerCount: 9 }, { startedAt: NaN },
    ]) assert.throws(() => normalizeLiveSessionsPayload(payload([row(overrides)])), /Invalid/);
    assert.throws(() => normalizeLiveSessionsPayload({ ...payload(), extra: true }), /Invalid/);
    assert.throws(() => normalizeLiveSessionsPayload(payload([row(), row()])), /Duplicate/);
    const exited = row({ status: 'exited', endedAt: 3000, exitReason: 'idle_timeout' });
    assert.equal(normalizeLiveSessionsPayload(payload([exited]))[0].exitReason, 'idle_timeout');
});

test('API keeps attach tokens in exact response bodies and mutation requests on same-origin paths', async () => {
    const calls = [];
    const options = { fetchImpl: async (url, request) => {
        calls.push({ url, request });
        if (request.method === 'GET') return response(payload());
        if (request.method === 'POST') return response({ ok: true, attach: TOKEN, expiresAt: Date.now() + 60000 }, 201);
        return response({ ok: true });
    } };
    assert.equal((await listLiveSessions(options)).length, 1);
    assert.equal(await mintLiveSessionAttach(ID, options), TOKEN);
    await killLiveSession(ID, options);
    assert.deepEqual(calls.map((call) => [call.url, call.request.method]), [
        ['/webtty/live-sessions', 'GET'], [`/webtty/live-sessions/${ID}/attach-tokens`, 'POST'], [`/webtty/sessions/${ID}`, 'DELETE'],
    ]);
    assert.equal(calls[1].request.body, '{}');
    assert.equal(calls[2].request.body, undefined);
    assert.ok(calls.every((call) => call.request.credentials === 'same-origin' && call.request.cache === 'no-store'));
    for (const body of [{ ok: true, attach: 'bad', expiresAt: Date.now() + 1000 }, { ok: true, attach: TOKEN, expiresAt: 0 }, { ok: true, attach: TOKEN, expiresAt: 1.5 }, { ok: true, attach: TOKEN, expiresAt: '5' }, { ok: true, attach: TOKEN, expiresAt: Date.now() + 1000, extra: true }]) {
        await assert.rejects(mintLiveSessionAttach(ID, { fetchImpl: async () => response(body, 201) }), /Invalid/);
    }
});

test('attach token acceptance does not compare expiresAt with the browser clock', async () => {
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 24 * 3600 * 1000;
    try {
        const stale = realNow() + 60000;
        assert.equal(await mintLiveSessionAttach(ID, { fetchImpl: async () => response({ ok: true, attach: TOKEN, expiresAt: stale }, 201) }), TOKEN);
    } finally {
        Date.now = realNow;
    }
});

test('non-admin makes zero list fetches even when the component is opened directly', async (t) => {
    const { modal } = environment(t, { admin: false });
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return response(payload()); };
    modal.afterRender();
    await modal.refresh();
    assert.equal(calls, 0);
    assert.equal(modal.pollTimer, null);
});

test('ordinary users discover agent rows through the modal without requesting the shell source', async (t) => {
    const { modal, elements } = environment(t, { admin: false });
    const source = {
        agent: 'roboTeamAgent', id: 'runs', label: 'Agent runs', contributionType: 'live-sessions-source',
        liveSessions: { version: 1, base: '/roboTeamAgent/api/live-sessions' },
    };
    globalThis.assistOS.workspace = { appPlugins: { 'live-sessions:source': [source] } };
    const urls = [];
    const agent = {
        ...row(), id: 'ls_task', source: 'roboTeamAgent', kind: 'workflow-phase', status: 'running',
        attach: { mode: 'event-stream' }, ownerState: 'verified', exit: null,
        capabilities: { watch: true, input: false, stop: true, message: true },
    };
    globalThis.fetch = async (url, options) => {
        urls.push(url);
        return options.method === 'POST' ? response({ ok: true }) : response(payload([agent]));
    };
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(urls, ['/roboTeamAgent/api/live-sessions']);
    const displayed = elements.get('#liveSessionsList').children[0];
    assert.equal(displayed.children[0].textContent, '<img onerror=bad>');
    const actions = displayed.children.find((child) => child.className === 'live-sessions-actions');
    assert.deepEqual(actions.children.map((button) => button.textContent), ['Watch', 'Pause workflow']);
    const key = '/roboTeamAgent/api/live-sessions:ls_task';
    await modal.performAction(key, 'kill');
    assert.match(elements.get('#liveSessionsList').children[0].children[3].textContent, /whole workflow/);
    await modal.performAction(key, 'confirm-kill');
    assert.equal(urls.filter((url) => url.endsWith('/ls_task/stop')).length, 1);
    assert.ok(urls.every((url) => !url.startsWith('/webtty')));
});

test('an unavailable source renders an independent error row while unauthorized agent sources are empty', async (t) => {
    const { modal, elements } = environment(t, { admin: false });
    const makeSource = (id) => ({ agent: 'roboTeamAgent', id, label: id, contributionType: 'live-sessions-source', liveSessions: { version: 1, base: `/roboTeamAgent/${id}` } });
    globalThis.assistOS.workspace = { appPlugins: { 'live-sessions:source': [makeSource('failed'), makeSource('forbidden')] } };
    globalThis.fetch = async (url) => response({}, url.endsWith('/forbidden') ? 403 : 500);
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    const displayed = elements.get('#liveSessionsList').children;
    assert.equal(displayed.length, 1);
    assert.equal(displayed[0].textContent, 'failed: This session source is unavailable.');
});

test('transient source polls preserve an attached agent view; authoritative removal and authorization refusal detach it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { modal } = environment(t, { admin: false });
    const source = { agent: 'roboTeamAgent', id: 'runs', label: 'Runs', contributionType: 'live-sessions-source', liveSessions: { version: 1, base: '/roboTeamAgent/runs' } };
    globalThis.assistOS.workspace = { appPlugins: { 'live-sessions:source': [source] } };
    const agent = { ...row(), id: 'ls_task', source: 'roboTeamAgent', kind: 'robot-task', status: 'running',
        attach: { mode: 'event-stream' }, ownerState: 'verified', exit: null,
        capabilities: { watch: true, input: false, stop: true, message: true } };
    let body = payload([agent]);
    let status = 200;
    let hung = false;
    let hungSignal;
    globalThis.fetch = async (_url, options) => {
        if (hung) { hungSignal = options.signal; return new Promise(() => {}); }
        return response(body, status);
    };
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    const key = '/roboTeamAgent/runs:ls_task';
    let unloads = 0;
    const presenter = { row: agent, form: {}, afterUnload() { unloads += 1; } };
    modal.viewerId = key;
    modal.streamPresenter = presenter;
    status = 503;
    await modal.refresh();
    assert.equal(modal.viewerId, key);
    assert.equal(modal.streamPresenter, presenter);
    assert.equal(unloads, 0);
    hung = true;
    const timeoutPoll = modal.refresh();
    t.mock.timers.tick(4999);
    assert.equal(hungSignal.aborted, false);
    t.mock.timers.tick(1);
    await timeoutPoll;
    assert.equal(hungSignal.aborted, true);
    assert.equal(modal.streamPresenter, presenter);
    assert.equal(modal.viewerId, key);
    assert.equal(unloads, 0);
    hung = false;
    status = 200;
    await modal.refresh();
    assert.equal(modal.streamPresenter, presenter);
    assert.equal(unloads, 0);
    body = payload([]);
    await modal.refresh();
    assert.equal(modal.viewerId, '');
    assert.equal(unloads, 1);
    body = payload([agent]);
    await modal.refresh();
    modal.viewerId = key;
    modal.streamPresenter = presenter;
    status = 403;
    await modal.refresh();
    assert.equal(modal.viewerId, '');
    assert.equal(unloads, 2);
    status = 200;
    await modal.refresh();
    modal.viewerId = key;
    modal.streamPresenter = presenter;
    body = payload([{ ...agent, status: 'stopped', exit: { reason: 'owner_stop' }, capabilities: { ...agent.capabilities, message: false, stop: false } }]);
    await modal.refresh();
    assert.equal(modal.viewerId, key);
    assert.equal(modal.streamPresenter, presenter);
    assert.equal(unloads, 2);
    body = payload([]);
    await modal.refresh();
    assert.equal(modal.viewerId, '');
    assert.equal(unloads, 3);
});

function endedAgentEnvironment(t, status) {
    const { modal, elements } = environment(t, { admin: false });
    const source = { agent: 'roboTeamAgent', id: 'runs', label: 'Runs', contributionType: 'live-sessions-source', liveSessions: { version: 1, base: '/roboTeamAgent/runs' } };
    globalThis.assistOS.workspace = { appPlugins: { 'live-sessions:source': [source] } };
    const agent = { ...row(), id: 'ls_task', source: 'roboTeamAgent', kind: 'robot-task', status,
        attach: { mode: 'event-stream' }, ownerState: 'verified',
        exit: status === 'running' ? null : { reason: 'completed', code: 0 },
        capabilities: { watch: true, input: false, stop: status === 'running', message: false } };
    let unloads = 0;
    let mounts = 0;
    const presenter = { form: {}, updateSession(updated) { this.row = updated; }, afterUnload() { unloads += 1; } };
    globalThis.assistOS.UI = {
        createElement() {
            mounts += 1;
            return { element: { deref: () => ({ presenterReadyPromise: Promise.resolve(), renderCompletePromise: Promise.resolve(), webSkelPresenter: presenter }) } };
        },
    };
    return { modal, elements, agent, presenter, counts: () => ({ unloads, mounts }) };
}

test('a finished agent row stays watchable and a later poll keeps the stream view', async (t) => {
    const { modal, agent, presenter, counts } = endedAgentEnvironment(t, 'finished');
    let body = payload([agent]);
    globalThis.fetch = async () => response(body);
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    const key = '/roboTeamAgent/runs:ls_task';
    await modal.performAction(key, 'attach');
    assert.equal(counts().mounts, 1);
    assert.equal(modal.viewerId, key);
    await modal.refresh();
    assert.equal(modal.viewerId, key);
    assert.equal(modal.streamPresenter, presenter);
    assert.equal(counts().unloads, 0);
    body = payload([]);
    await modal.refresh();
    assert.equal(modal.viewerId, '');
    assert.equal(counts().unloads, 1);
});

test('a watched running agent row that finishes keeps its stream view with the final exit line', async (t) => {
    const { modal, agent, presenter, counts } = endedAgentEnvironment(t, 'running');
    let body = payload([agent]);
    globalThis.fetch = async () => response(body);
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    const key = '/roboTeamAgent/runs:ls_task';
    await modal.performAction(key, 'attach');
    assert.equal(modal.viewerId, key);
    body = payload([{ ...agent, status: 'finished', exit: { reason: 'completed', code: 0 }, capabilities: { ...agent.capabilities, stop: false } }]);
    await modal.refresh();
    assert.equal(modal.viewerId, key);
    assert.equal(modal.streamPresenter, presenter);
    assert.equal(presenter.row.status, 'finished');
    assert.equal(counts().unloads, 0);
});

test('a viewed shell still detaches when it exits and exited shell rows offer no Attach', async (t) => {
    const { modal, elements } = environment(t);
    let body = payload();
    globalThis.fetch = async () => response(body);
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    modal.viewerId = ID;
    body = payload([row({ status: 'exited', endedAt: 3000, exitReason: 'idle_timeout' })]);
    await modal.refresh();
    assert.equal(modal.viewerId, '');
    const item = elements.get('#liveSessionsList').children[0];
    assert.equal(item.children.some((child) => child.dataset?.sessionAction === 'attach' || child.children?.some?.((b) => b.dataset?.sessionAction === 'attach')), false);
});

test('temporary shell-list errors preserve its iframe while authorization refusal detaches it', async (t) => {
    const { modal, elements } = environment(t);
    let status = 200;
    globalThis.fetch = async () => response(payload(), status);
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    const frame = new Element('iframe');
    modal.viewerId = ID;
    elements.get('#liveSessionsFrame').replaceChildren(frame);
    status = 503;
    await modal.refresh();
    assert.equal(modal.viewerId, ID);
    assert.equal(elements.get('#liveSessionsFrame').children[0], frame);
    status = 401;
    await modal.refresh();
    assert.equal(modal.viewerId, '');
    assert.equal(elements.get('#liveSessionsFrame').children.length, 0);
});

test('older Ploinky HTML 404 renders the upgrade notice and stops polling', async (t) => {
    const { modal, elements } = environment(t);
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return { ok: false, status: 404, async json() { throw new Error('HTML'); } }; };
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    await modal.refresh();
    assert.equal(calls, 1);
    assert.equal(elements.get('#liveSessionsStatus').textContent, 'Live Sessions needs a newer Ploinky');
    assert.equal(modal.pollTimer, null);
});

test('attach embeds a no-referrer fragment without putting the token in a descriptor or storage; closing detaches only', async (t) => {
    const { modal, elements } = environment(t);
    const storageWrites = [];
    const storage = { setItem: (...args) => storageWrites.push(args), getItem: () => null };
    globalThis.sessionStorage = storage;
    globalThis.localStorage = storage;
    const descriptors = [];
    globalThis.assistOS.UI = {
        openExpandedModal,
        showModal: async (_name, descriptor) => {
            descriptors.push(descriptor);
            return { querySelector: () => null, addEventListener() {}, close() {}, remove() {} };
        },
    };
    const button = new LiveSessionsToolButton(new Element(), () => {});
    button.updateHostContext(HOST_CONTEXT);
    button.openSessions();
    await new Promise((resolve) => setImmediate(resolve));
    const methods = [];
    globalThis.fetch = async (_path, options) => {
        methods.push(options.method);
        return options.method === 'GET' ? response(payload()) : response({ ok: true, attach: TOKEN, expiresAt: Date.now() + 60000 }, 201);
    };
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    await modal.performAction(ID, 'attach');
    const frame = elements.get('#liveSessionsFrame').children[0];
    assert.match(frame.src, /^\/webtty\/#attach=[A-Za-z0-9_-]{32}$/);
    assert.equal(frame.referrerPolicy, 'no-referrer');
    assert.equal(frame.src, `/webtty/#attach=${TOKEN}`);
    assert.equal(descriptors.length, 1);
    // The panel opens as the Live Sessions page in the expanded modal's iframe, titled by the host's label.
    assert.equal(descriptors[0].mode, 'iframe');
    assert.equal(descriptors[0].url, PAGE_URL);
    assert.equal(descriptors[0]['ready-title'], 'Live Sessions');
    assert.equal(descriptors[0].title, 'Live Sessions');
    assert.equal(descriptors[0].component, undefined);
    assert.equal(descriptors[0].key, PAGE_URL, 'the modal dialog is keyed by the page URL, which the shell bridge trusts');
    assert.ok(descriptors.every((descriptor) => !JSON.stringify(descriptor).includes(TOKEN)));
    assert.deepEqual(storageWrites, []);
    modal.afterUnload();
    assert.deepEqual(elements.get('#liveSessionsFrame').children, []);
    assert.equal(methods.filter((method) => method === 'DELETE').length, 0);
});

test('Kill needs an inline confirmation and sends exactly one DELETE; exited rows have no actions', async (t) => {
    const { modal, elements } = environment(t);
    let deletes = 0;
    globalThis.fetch = async (_path, options) => {
        if (options.method === 'DELETE') { deletes += 1; return response({ ok: true }); }
        return response(payload([row(), row({ id: 'E'.repeat(32), status: 'exited', exitReason: 'shell_exit' })]));
    };
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements.get('#liveSessionsList').children[1].children.some((child) => child.className === 'live-sessions-actions'), false);
    await modal.performAction(ID, 'confirm-kill');
    assert.equal(deletes, 0);
    await modal.performAction(ID, 'kill');
    assert.equal(deletes, 0);
    await modal.performAction(ID, 'confirm-kill');
    assert.equal(deletes, 1);
});

test('modal aborts pending list requests and ignores late results after removal', async (t) => {
    const { modal, elements } = environment(t);
    let signal;
    let resolve;
    globalThis.fetch = (_path, options) => {
        signal = options.signal;
        return new Promise((done) => { resolve = done; });
    };
    modal.afterRender();
    modal.afterUnload();
    assert.equal(signal.aborted, true);
    resolve(response(payload()));
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(elements.get('#liveSessionsList').children, []);
    assert.equal(modal.pollTimer, null);
});

test('polling waits five seconds after each completed read and stops on unload', async (t) => {
    const { modal } = environment(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return response(payload()); };
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    t.mock.timers.tick(4999);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    modal.afterUnload();
    t.mock.timers.tick(5000);
    assert.equal(calls, 2);
});

test('pop-out reserves an isolated blank tab before minting a fresh token on every click', async (t) => {
    const { modal } = environment(t);
    const order = [];
    const anchors = [];
    globalThis.window = {
        open(url, target) {
            order.push('open');
            assert.equal(url, 'about:blank');
            assert.equal(target, '_blank');
            return {
                opener: {},
                document: {
                    createElement() {
                        const anchor = { click() { order.push('navigate'); } };
                        anchors.push(anchor);
                        return anchor;
                    },
                    body: { appendChild() {} },
                },
                close() { order.push('close'); },
            };
        },
    };
    let tokens = 0;
    globalThis.fetch = async (_path, options) => {
        if (options.method === 'GET') return response(payload());
        order.push('mint');
        tokens += 1;
        return response({ ok: true, attach: String(tokens).repeat(32), expiresAt: Date.now() + 60000 }, 201);
    };
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    await modal.performAction(ID, 'pop-out');
    await modal.performAction(ID, 'pop-out');
    assert.deepEqual(order, ['open', 'mint', 'navigate', 'open', 'mint', 'navigate']);
    assert.equal(tokens, 2);
    assert.deepEqual(anchors.map((anchor) => anchor.href), [`/webtty/#attach=${'1'.repeat(32)}`, `/webtty/#attach=${'2'.repeat(32)}`]);
    assert.ok(anchors.every((anchor) => anchor.referrerPolicy === 'no-referrer' && anchor.rel === 'noopener noreferrer'));
});

test('closing during token mint closes the reserved tab and never navigates its late response', async (t) => {
    const { modal, elements } = environment(t);
    let closed = 0;
    let navigations = 0;
    let resolve;
    globalThis.window = { open: () => ({ opener: {}, close() { closed += 1; }, document: { createElement() { navigations += 1; } } }) };
    globalThis.fetch = async (_path, options) => {
        if (options.method === 'GET') return response(payload());
        return new Promise((done) => { resolve = done; });
    };
    modal.afterRender();
    await new Promise((done) => setImmediate(done));
    const operation = modal.performAction(ID, 'pop-out');
    modal.afterUnload();
    resolve(response({ ok: true, attach: TOKEN, expiresAt: Date.now() + 60000 }, 201));
    await operation;
    assert.equal(closed, 1);
    assert.equal(navigations, 0);
    assert.deepEqual(elements.get('#liveSessionsFrame').children, []);
});

test('foreign administrators get text-only watch rows and exited rows cannot attach', async (t) => {
    const { modal, elements } = environment(t);
    const foreign = row({ isOwner: false, capabilities: { watch: true, input: false, stop: true, message: false } });
    const endedId = 'E'.repeat(32);
    let mutations = 0;
    globalThis.fetch = async (_path, options) => {
        if (options.method !== 'GET') mutations += 1;
        return response(payload([foreign, row({ id: endedId, status: 'exited', exitReason: 'idle_timeout' })]));
    };
    modal.afterRender();
    await new Promise((done) => setImmediate(done));
    const displayed = elements.get('#liveSessionsList').children[0];
    assert.equal(displayed.children[0].textContent, '<img onerror=bad>');
    assert.equal(displayed.children[0].children.length, 0);
    assert.match(displayed.children[2].textContent, /Watch only/);
    assert.match(elements.get('#liveSessionsList').children[1].children[2].textContent, /Input closed/);
    await modal.performAction(endedId, 'attach');
    await modal.performAction(endedId, 'pop-out');
    assert.equal(mutations, 0);
});

test('confirm-stop on a watched agent row keeps the stream view while confirm-kill on a watched shell detaches', async (t) => {
    const { modal, agent, presenter, counts } = endedAgentEnvironment(t, 'running');
    let body = payload([agent]);
    globalThis.fetch = async (_url, options) => options?.method === 'POST' ? response({ ok: true }) : response(body);
    modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    const key = '/roboTeamAgent/runs:ls_task';
    await modal.performAction(key, 'attach');
    modal.confirmId = key;
    await modal.performAction(key, 'confirm-kill');
    assert.equal(modal.viewerId, key);
    assert.equal(modal.streamPresenter, presenter);
    assert.equal(counts().unloads, 0);

    const shell = environment(t);
    globalThis.fetch = async (_url, options) => options?.method === 'DELETE' ? response({ ok: true }) : response(payload());
    shell.modal.afterRender();
    await new Promise((resolve) => setImmediate(resolve));
    shell.modal.viewerId = ID;
    shell.modal.confirmId = ID;
    await shell.modal.performAction(ID, 'confirm-kill');
    assert.equal(shell.modal.viewerId, '');
});

// ---------------------------------------------------------------------------------------------------------------
// Close policy, closure outcomes, embedded owner view, Explorer restore and the return cue (plan r3 3.6, A11).
// ---------------------------------------------------------------------------------------------------------------

const ORIGIN = 'https://explorer.test';
const VIEW = 'V'.repeat(32);
const SECOND_ID = 'Q'.repeat(32);
const settle = async () => { for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

function fakeWindow(origin = ORIGIN) {
    const listeners = new Map();
    return {
        location: { origin },
        addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
        removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
        dispatch(type, event) { for (const handler of [...(listeners.get(type) || [])]) handler(event); },
        count(type) { return listeners.get(type)?.size || 0; },
    };
}

function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => { data.set(key, String(value)); },
        removeItem: (key) => { data.delete(key); },
    };
}

const unattended = (changes = {}) => row({
    closePolicy: 'stop', pendingStopUntil: null, ownerViewOpen: false, profileLabel: 'Robot A', ...changes,
});
const tombstone = (changes = {}) => row({
    status: 'exited', endedAt: 3000, exitReason: 'tab_closed', closePolicy: 'stop', pendingStopUntil: null,
    ownerViewOpen: false, closure: 'proven', ...changes,
});
const listText = (elements, index) => {
    const walk = (node) => `${node.textContent || ''}${(node.children || []).map(walk).join('|')}`;
    return walk(elements.get('#liveSessionsList').children[index]);
};

test('shell payload accepts an optional boolean available flag and the shell-only optional keys', () => {
    assert.equal(parseLiveSessionsPayload(payload()).available, true);
    assert.equal(parseLiveSessionsPayload({ ...payload(), available: true }).available, true);
    const disabled = parseLiveSessionsPayload({ ...payload([tombstone({ closure: 'unconfirmed', closureScope: 'global', recordCleanup: 'failed' })]), available: false });
    assert.equal(disabled.available, false);
    assert.equal(disabled.rows[0].closureScope, 'global');
    assert.equal(normalizeLiveSessionsPayload({ ...payload(), available: false }).length, 1);
    for (const available of ['no', 0, null, undefined]) {
        assert.throws(() => parseLiveSessionsPayload({ ...payload(), available }), /Invalid/);
    }
    assert.throws(() => parseLiveSessionsPayload({ ...payload(), unavailable: true }), /Invalid/);

    const live = normalizeLiveSessionsPayload(payload([
        unattended({ pendingStopUntil: 5000, ownerViewOpen: true }),
    ]))[0];
    assert.deepEqual([live.closePolicy, live.pendingStopUntil, live.ownerViewOpen, live.profileLabel], ['stop', 5000, true, 'Robot A']);
    assert.equal(normalizeLiveSessionsPayload(payload([row({ profileLabel: null, pendingStopUntil: null })]))[0].profileLabel, null);
    for (const closure of ['pending', 'proven']) {
        assert.equal(normalizeLiveSessionsPayload(payload([tombstone({ closure, recordCleanup: 'failed' })]))[0].closure, closure);
    }
});

test('shell-only optional keys are rejected when mistyped, misplaced or carried by an agent row', () => {
    for (const changes of [
        { closePolicy: 'maybe' }, { pendingStopUntil: -1 }, { pendingStopUntil: 1.5 }, { pendingStopUntil: '5' }, { pendingStopUntil: 0 },
        { ownerViewOpen: 'yes' }, { profileLabel: '' }, { profileLabel: 'bad\nlabel' }, { profileLabel: 'x'.repeat(129) },
        { closure: 'pending' }, // a live row has no closure
        { closureScope: 'global' }, { recordCleanup: 'failed' }, { principal: 'private' },
    ]) assert.throws(() => normalizeLiveSessionsPayload(payload([row(changes)])), /Invalid/, JSON.stringify(changes));
    for (const changes of [
        { closure: 'done' }, { closure: 'proven', closureScope: 'global' }, { closure: 'unconfirmed', closureScope: 'planet' },
        { closureScope: 'global' }, { recordCleanup: 'ok' }, { recordCleanup: true },
    ]) assert.throws(() => normalizeLiveSessionsPayload(payload([tombstone(changes)])), /Invalid/, JSON.stringify(changes));

    const source = { agent: 'roboTeamAgent', liveSessions: { version: 1, base: '/roboTeamAgent/runs' } };
    const agent = { ...row(), id: 'ls_task', source: 'roboTeamAgent', kind: 'robot-task', status: 'running', ownerState: 'verified', exit: null,
        attach: { mode: 'event-stream' }, capabilities: { watch: true, input: false, stop: true, message: false } };
    assert.equal(normalizeAgentSessionsPayload(payload([agent]), source).length, 1);
    for (const extra of [
        { closePolicy: 'stop' }, { pendingStopUntil: null }, { ownerViewOpen: false }, { profileLabel: 'Robot A' },
        { closure: 'proven' }, { closureScope: 'global' }, { recordCleanup: 'failed' },
    ]) assert.throws(() => normalizeAgentSessionsPayload(payload([{ ...agent, ...extra }]), source), /Invalid/, JSON.stringify(extra));
    assert.throws(() => normalizeAgentSessionsPayload({ ...payload([agent]), available: false }, source), /Invalid/);
});

test('close-policy request is an exact owner POST and its response is validated', async () => {
    const calls = [];
    globalThis.document = { cookie: 'ploinky_browser_csrf=v1.policy-proof' };
    const fetchImpl = async (url, request) => {
        calls.push({ url, request });
        return response({ ok: true, closePolicy: 'keep', pendingStopUntil: null });
    };
    const result = await setLiveSessionClosePolicy(ID, 'keep', { fetchImpl });
    assert.deepEqual(result, { closePolicy: 'keep', pendingStopUntil: null });
    assert.equal(calls[0].url, `/webtty/sessions/${ID}/close-policy`);
    assert.equal(calls[0].request.method, 'POST');
    assert.equal(calls[0].request.body, '{"policy":"keep"}');
    assert.equal(calls[0].request.headers['X-Ploinky-Browser-CSRF-Token'], 'v1.policy-proof');
    assert.equal(calls[0].request.credentials, 'same-origin');
    delete globalThis.document;

    for (const body of [
        { ok: true, closePolicy: 'keep' }, { ok: true, closePolicy: 'later', pendingStopUntil: null },
        { ok: true, closePolicy: 'stop', pendingStopUntil: 'soon' }, { ok: true, closePolicy: 'stop', pendingStopUntil: null, extra: 1 },
        { ok: false, closePolicy: 'keep', pendingStopUntil: null },
    ]) await assert.rejects(setLiveSessionClosePolicy(ID, 'keep', { fetchImpl: async () => response(body) }), /Invalid/);
    await assert.rejects(setLiveSessionClosePolicy(ID, 'later', { fetchImpl }), /Invalid/);
    await assert.rejects(setLiveSessionClosePolicy('../x', 'keep', { fetchImpl }), /Invalid/);
    await assert.rejects(setLiveSessionClosePolicy(ID, 'keep', { fetchImpl: async () => response({}, 409) }), (error) => error.status === 409);
});

test('close intent is one keepalive POST with the mutation proof and exact {view, policy}', async () => {
    globalThis.document = { cookie: 'ploinky_browser_csrf=v1.intent-proof' };
    const calls = [];
    try {
        await sendLiveSessionCloseIntent(ID, VIEW, 'stop', { fetchImpl: async (url, request) => { calls.push({ url, request }); return response({ ok: true }, 202); } });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, `/webtty/sessions/${ID}/close-intents`);
        assert.equal(calls[0].request.method, 'POST');
        assert.equal(calls[0].request.keepalive, true);
        assert.equal(calls[0].request.credentials, 'same-origin');
        assert.equal(calls[0].request.headers['X-Ploinky-Browser-CSRF-Token'], 'v1.intent-proof');
        assert.deepEqual(JSON.parse(calls[0].request.body), { view: VIEW, policy: 'stop' });
        assert.deepEqual(Object.keys(JSON.parse(calls[0].request.body)), ['view', 'policy']);
        // Invalid views and policies send nothing; a lost request is swallowed because a missing signal stops nothing.
        assert.equal(sendLiveSessionCloseIntent(ID, 'short', 'stop', { fetchImpl: async () => { throw new Error('unreachable'); } }), undefined);
        assert.equal(sendLiveSessionCloseIntent(ID, VIEW, 'later', { fetchImpl: async () => { throw new Error('unreachable'); } }), undefined);
        await sendLiveSessionCloseIntent(ID, VIEW, 'keep', { fetchImpl: async () => { throw new Error('offline'); } });
        assert.equal(sendLiveSessionCloseIntent(ID, VIEW, 'keep', { fetchImpl: () => { throw new Error('sync'); } }), undefined);
    } finally {
        delete globalThis.document;
    }
});

test('status texts: pending countdown, still running after a missed signal, and each closure scope', () => {
    const now = 1_000_000;
    assert.equal(closePolicyStatusText(unattended({ pendingStopUntil: now + 12_500 }), now), 'Stops in 13 s unless reopened');
    assert.equal(closePolicyStatusText(unattended({ pendingStopUntil: now - 5 }), now), 'Stops in 0 s unless reopened');
    assert.equal(closePolicyStatusText(unattended(), now), 'Set to stop on close, still running');
    assert.equal(closePolicyStatusText(unattended({ ownerViewOpen: true }), now), '');
    assert.equal(closePolicyStatusText(row({ closePolicy: 'keep', ownerViewOpen: false, pendingStopUntil: null }), now), '');
    assert.equal(closePolicyStatusText(row(), now), '', 'a row from an older Ploinky reports nothing');
    assert.equal(closePolicyStatusText(tombstone(), now), '');

    assert.equal(closureText(tombstone({ closure: 'pending' })), 'Stopping…');
    assert.equal(closureText(tombstone({ closure: 'proven' })), 'Stopped (confirmed)');
    assert.equal(closureText(tombstone({ closure: 'unconfirmed', closureScope: 'global' })), 'Stop not confirmed; terminal service disabled for safety');
    assert.equal(closureText(tombstone({ closure: 'unconfirmed', closureScope: 'provider' })), 'Stop not confirmed; agent terminals disabled for safety');
    assert.equal(closureText(tombstone({ closure: 'unconfirmed', closureScope: 'target' })), 'Stop not confirmed; this agent is quarantined for terminals');
    assert.equal(closureText(tombstone({ closure: 'unconfirmed' })), 'Stop not confirmed');
    assert.equal(closureText(tombstone({ closure: undefined })), '');
    assert.doesNotMatch(closureText(tombstone({ closure: 'pending' })), /confirmed/i);
});

test('rows show the profile, the close policy, closure outcomes, the cleanup flag and the disabled banner', async (t) => {
    const { modal, elements } = environment(t);
    const rows = [
        unattended({ id: ID, title: 'Terminal A', profileLabel: 'Robot A' }),
        unattended({ id: SECOND_ID, title: 'Terminal B', profileLabel: null, pendingStopUntil: Date.now() + 20_000 }),
        tombstone({ id: 'A'.repeat(32), closure: 'unconfirmed', closureScope: 'target', recordCleanup: 'failed' }),
        tombstone({ id: 'B'.repeat(32), closure: 'pending' }),
        tombstone({ id: 'C'.repeat(32) }),
        row({ id: 'D'.repeat(32), title: 'Legacy' }),
    ];
    let body = { ...payload(rows), available: false };
    globalThis.fetch = async () => response(body);
    modal.afterRender();
    await settle();

    const list = elements.get('#liveSessionsList').children;
    assert.equal(list[0].textContent, 'Terminals are disabled for safety. Only retained stop results are listed.');
    assert.equal(list[0].role, 'alert');
    assert.equal(list.length, 7);
    const texts = [1, 2, 3, 4, 5, 6].map((index) => listText(elements, index));
    assert.match(texts[0], /Profile: Robot A · When its tab closes: Stop it/);
    assert.match(texts[0], /Set to stop on close, still running/);
    assert.match(texts[1], /^.*Terminal B/);
    assert.doesNotMatch(texts[1], /Profile:/);
    assert.match(texts[1], /Stops in (19|20) s unless reopened/);
    assert.doesNotMatch(texts[1], /Set to stop on close, still running/);
    assert.match(texts[2], /Stop not confirmed; this agent is quarantined for terminals/);
    assert.match(texts[2], /Record cleanup failed/);
    assert.match(texts[3], /Stopping…/);
    assert.match(texts[4], /Stopped \(confirmed\)/);
    assert.doesNotMatch(texts[5], /When its tab closes|Set to stop|Stopped|Stopping/);
    for (const index of [3, 4, 5]) assert.equal(elements.get('#liveSessionsList').children[index].children.some((child) => child.className === 'live-sessions-actions'), false);

    body = payload(rows);
    await modal.refresh();
    assert.notEqual(elements.get('#liveSessionsList').children[0].role, 'alert', 'the banner disappears with available');
    assert.equal(elements.get('#liveSessionsList').children.length, 6);
});

test('aggregate reports the shell available flag and never invents one for agent sources', async () => {
    const source = { agent: 'roboTeamAgent', id: 'runs', label: 'Runs', contributionType: 'live-sessions-source', liveSessions: { version: 1, base: '/roboTeamAgent/runs' } };
    const fetchImpl = async (url) => response(url === '/webtty/live-sessions' ? { ...payload([tombstone()]), available: false } : payload([]));
    const results = await aggregateLiveSessions([source], { admin: true, fetchImpl });
    const shell = results.find((result) => result.source.shell);
    const agent = results.find((result) => !result.source.shell);
    assert.equal(shell.available, false);
    assert.equal(shell.rows.length, 1);
    assert.equal(Object.hasOwn(agent, 'available'), false);
    assert.equal((await listLiveSessionsDetailed({ fetchImpl })).available, false);
    assert.equal((await listLiveSessions({ fetchImpl })).length, 1);
});

test('Keep running posts close-policy keep once for an owner; Kill keeps its confirmation; others cannot keep', async (t) => {
    const { modal, elements } = environment(t);
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push([options.method, url, options.body]);
        if (options.method === 'POST') return response({ ok: true, closePolicy: 'keep', pendingStopUntil: null });
        return response(payload([
            unattended(),
            unattended({ id: SECOND_ID, isOwner: false, capabilities: { watch: true, input: false, stop: true, message: false } }),
            row({ id: 'K'.repeat(32), closePolicy: 'keep', ownerViewOpen: false, pendingStopUntil: null }),
        ]));
    };
    modal.afterRender();
    await settle();
    const buttons = (index) => elements.get('#liveSessionsList').children[index].children
        .find((child) => child.className === 'live-sessions-actions').children.map((button) => button.textContent);
    assert.deepEqual(buttons(0), ['Attach', 'Keep running', 'Pop out', 'Kill']);
    assert.deepEqual(buttons(1), ['Attach', 'Pop out', 'Kill']);
    assert.deepEqual(buttons(2), ['Attach', 'Pop out', 'Kill']);

    await modal.performAction(SECOND_ID, 'keep-running');
    await modal.performAction('K'.repeat(32), 'keep-running');
    assert.deepEqual(calls.filter((call) => call[0] !== 'GET'), []);

    await modal.performAction(ID, 'keep-running');
    await settle();
    assert.deepEqual(calls.filter((call) => call[0] !== 'GET'), [['POST', `/webtty/sessions/${ID}/close-policy`, '{"policy":"keep"}']]);
    assert.ok(calls.filter((call) => call[0] === 'GET').length >= 2, 'the list is refreshed after the action');
    assert.ok(!calls.some((call) => call[0] === 'DELETE'));
});

function embeddedEnvironment(t, rows = [unattended()]) {
    const env = environment(t);
    const win = fakeWindow();
    globalThis.window = win;
    globalThis.sessionStorage = memoryStorage();
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (options.method === 'GET') return response(payload(rows));
        if (url.endsWith('/attach-tokens')) return response({ ok: true, attach: TOKEN, expiresAt: Date.now() + 60000 }, 201);
        return response({ ok: true }, 202);
    };
    globalThis.document.cookie = 'ploinky_browser_csrf=v1.embedded-proof';
    const frame = () => env.elements.get('#liveSessionsFrame').children[0];
    const announce = (overrides = {}, event = {}) => win.dispatch('message', {
        source: frame().contentWindow, origin: ORIGIN,
        data: { type: 'ploinky-webtty:view', sessionId: ID, viewId: VIEW, role: 'owner', policy: 'stop', ...overrides },
        ...event,
    });
    return { ...env, win, calls, frame, announce, storage: globalThis.sessionStorage };
}

test('embedded owner view ignores foreign windows, origins, shapes and roles; a valid announcement registers pagehide and the key', async (t) => {
    const page = embeddedEnvironment(t);
    page.modal.afterRender();
    await settle();
    await page.modal.performAction(ID, 'attach');
    const frame = page.frame();
    frame.contentWindow = { name: 'iframe' };
    assert.equal(frame.src, `/webtty/#attach=${TOKEN}`);
    assert.equal(page.win.count('message'), 1);
    const { data } = { data: { type: 'ploinky-webtty:view', sessionId: ID, viewId: VIEW, role: 'owner', policy: 'stop' } };

    const forged = [
        { source: { name: 'another window' } }, { source: null }, { source: undefined },
        { origin: 'https://evil.test' }, { origin: 'null' },
        { data: { ...data, extra: 1 } }, { data: { type: data.type, sessionId: ID, viewId: VIEW, role: 'owner' } },
        { data: { ...data, type: 'other' } }, { data: { ...data, sessionId: SECOND_ID } }, { data: { ...data, role: 'watcher' } },
        { data: { ...data, viewId: 'short' } }, { data: { ...data, viewId: 'bad id'.padEnd(32, 'x') } }, { data: { ...data, policy: 'later' } },
        { data: null }, { data: 'ploinky-webtty:view' }, { data: [] },
    ];
    for (const event of forged) {
        page.win.dispatch('message', { source: frame.contentWindow, origin: ORIGIN, data, ...event });
    }
    assert.equal(page.win.count('pagehide'), 0);
    assert.equal(page.storage.data.size, 0);
    page.win.dispatch('pagehide', {});
    assert.equal(page.calls.filter((call) => call.options.method === 'POST' && call.url.includes('close-intents')).length, 0);

    page.announce();
    assert.equal(page.win.count('pagehide'), 1);
    assert.equal(page.storage.data.get(EMBEDDED_TERMINAL_KEY), JSON.stringify({ sessionId: ID, viewId: VIEW }));
    assert.deepEqual(readEmbeddedTerminalKey(), { sessionId: ID, viewId: VIEW });
    // A later announcement (policy change, bfcache re-attach) updates the view without a second listener.
    const second = 'W'.repeat(32);
    page.announce({ viewId: second, policy: 'keep' });
    assert.equal(page.win.count('pagehide'), 1);

    const before = page.calls.length;
    page.win.dispatch('pagehide', { persisted: false });
    const intents = page.calls.slice(before);
    assert.equal(intents.length, 1);
    assert.equal(intents[0].url, `/webtty/sessions/${ID}/close-intents`);
    assert.equal(intents[0].options.method, 'POST');
    assert.equal(intents[0].options.keepalive, true);
    assert.equal(intents[0].options.headers['X-Ploinky-Browser-CSRF-Token'], 'v1.embedded-proof');
    assert.deepEqual(JSON.parse(intents[0].options.body), { view: second, policy: 'keep' });
    assert.equal(page.storage.data.get(EMBEDDED_TERMINAL_KEY), JSON.stringify({ sessionId: ID, viewId: second }), 'page hide must not clear the restore key');
    assert.equal(page.win.count('pagehide'), 1);
});

test('detaching, switching, refreshing away and closing the panel clear the key and listeners without any request', async (t) => {
    const second = unattended({ id: SECOND_ID, title: 'Terminal B' });
    const page = embeddedEnvironment(t, [unattended(), second]);
    page.modal.afterRender();
    await settle();
    await page.modal.performAction(ID, 'attach');
    page.frame().contentWindow = { name: 'first' };
    page.announce();
    assert.equal(page.storage.data.size, 1);
    let before = page.calls.length;

    // Switching to another session replaces the embedded view and clears the previous registration first.
    await page.modal.performAction(SECOND_ID, 'attach');
    const switched = page.calls.slice(before);
    assert.deepEqual(switched.map((call) => call.url), [`/webtty/live-sessions/${SECOND_ID}/attach-tokens`]);
    assert.equal(page.win.count('pagehide'), 0);
    assert.equal(page.storage.data.size, 0);
    assert.equal(page.win.count('message'), 1);
    page.frame().contentWindow = { name: 'second' };
    page.announce({ sessionId: SECOND_ID });
    assert.equal(readEmbeddedTerminalKey().sessionId, SECOND_ID);
    page.win.dispatch('message', { source: { name: 'first' }, origin: ORIGIN, data: { type: 'ploinky-webtty:view', sessionId: ID, viewId: VIEW, role: 'owner', policy: 'stop' } });
    assert.equal(readEmbeddedTerminalKey().sessionId, SECOND_ID, 'the old frame can no longer register anything');

    // Detach view.
    before = page.calls.length;
    page.modal.detachViewer();
    assert.equal(page.calls.length, before);
    assert.equal(page.storage.data.size, 0);
    assert.equal(page.win.count('pagehide'), 0);
    assert.equal(page.win.count('message'), 0);
    page.win.dispatch('pagehide', {});
    assert.equal(page.calls.length, before, 'a detached view sends no close intent');

    // Closing the panel while attached.
    await page.modal.performAction(ID, 'attach');
    page.frame().contentWindow = { name: 'third' };
    page.announce();
    assert.equal(page.storage.data.size, 1);
    before = page.calls.length;
    page.modal.afterUnload();
    page.win.dispatch('pagehide', {});
    assert.equal(page.calls.length, before);
    assert.equal(page.storage.data.size, 0);
    assert.equal(page.win.count('message') + page.win.count('pagehide'), 0);
});

test('a watcher or an exited shell never registers a close intent', async (t) => {
    const page = embeddedEnvironment(t, [unattended({ isOwner: false, capabilities: { watch: true, input: false, stop: true, message: false } })]);
    page.modal.afterRender();
    await settle();
    await page.modal.performAction(ID, 'attach');
    page.frame().contentWindow = { name: 'watcher' };
    assert.equal(page.win.count('message'), 0, 'a foreign administrator is only watching');
    page.announce({ role: 'watcher' });
    page.announce({ role: 'owner' });
    page.win.dispatch('pagehide', {});
    assert.equal(page.storage.data.size, 0);
    assert.equal(page.calls.filter((call) => call.url.includes('close-intents')).length, 0);
});

test('a viewed shell that exits or disappears clears the key and listeners', async (t) => {
    let rows = [unattended()];
    const page = embeddedEnvironment(t, rows);
    globalThis.fetch = async (url, options) => {
        page.calls.push({ url, options });
        if (options.method === 'GET') return response(payload(rows));
        return response({ ok: true, attach: TOKEN, expiresAt: Date.now() + 60000 }, 201);
    };
    page.modal.afterRender();
    await settle();
    await page.modal.performAction(ID, 'attach');
    page.frame().contentWindow = { name: 'first' };
    page.announce();
    assert.equal(page.storage.data.size, 1);
    rows = [tombstone()];
    await page.modal.refresh();
    assert.equal(page.modal.viewerId, '');
    assert.equal(page.storage.data.size, 0);
    assert.equal(page.win.count('pagehide') + page.win.count('message'), 0);
});

function startupEnvironment(t, { admin = true, rows = [unattended()], key = { sessionId: ID, viewId: VIEW }, fetchImpl = null } = {}) {
    const env = environment(t, { admin });
    const win = fakeWindow();
    globalThis.window = win;
    globalThis.sessionStorage = memoryStorage(key ? { [EMBEDDED_TERMINAL_KEY]: JSON.stringify(key) } : {});
    publishCue(0);
    const calls = [];
    const opened = [];
    // The expanded modal's promise stays pending until the panel is closed, as the real one does.
    const closers = [];
    globalThis.assistOS.UI = {
        openExpandedModal: (descriptor) => {
            opened.push(descriptor);
            return new Promise((resolve) => { closers.push(resolve); });
        },
    };
    globalThis.fetch = fetchImpl || (async (url, options) => {
        calls.push({ url, method: options.method, ...(options.body === undefined ? {} : { body: options.body }) });
        if (options.method === 'GET') return response(payload(rows));
        return response({ ok: true, attach: TOKEN, expiresAt: Date.now() + 60000 }, 201);
    });
    const badge = new Element('span');
    badge.hidden = true;
    const button = new Element('button');
    const host = new Element();
    host.querySelector = (selector) => ({ '#liveSessionsToolButton': button, '#liveSessionsBadge': badge })[selector] || null;
    const toolButton = new LiveSessionsToolButton(host, () => {});
    // The host hands the presenter its descriptor before the start work needs it.
    toolButton.hostContext = HOST_CONTEXT;
    t.after(() => { toolButton.afterUnload(); publishCue(0); });
    const closePanel = () => { for (const close of closers.splice(0)) close(); };
    // The panel the host opens is a new Live Sessions page; it reads the stored key when it starts.
    const newPage = () => {
        const page = new LiveSessionsModal(Object.assign(new Element(), { querySelector: (selector) => env.elements.get(selector) }), () => {});
        t.after(() => page.afterUnload());
        return page;
    };
    return { ...env, calls, opened, badge, button, toolButton, host, closePanel, newPage, win, storage: globalThis.sessionStorage };
}

test('Explorer start makes one shell-list read, restores a still-owned embedded terminal through attach tokens, and shows the badge', async (t) => {
    const page = startupEnvironment(t, { rows: [unattended(), tombstone({ id: 'U'.repeat(32), closure: 'unconfirmed', closureScope: 'global' })] });
    page.toolButton.afterRender();
    await settle();

    assert.deepEqual(page.calls, [{ url: '/webtty/live-sessions', method: 'GET' }], 'exactly one GET at start');
    assert.equal(page.badge.textContent, '2');
    assert.equal(page.badge.hidden, false);
    assert.equal(currentCue(), 2);
    assert.equal(page.opened.length, 1);
    assert.deepEqual(page.opened[0], { ...PAGE_DESCRIPTOR, title: 'Live Sessions' });
    assert.ok(!JSON.stringify(page.opened).includes(ID) && !JSON.stringify(page.opened).includes(VIEW),
        'the descriptor carries no session or view identifier');
    assert.equal(page.storage.data.get(EMBEDDED_TERMINAL_KEY), JSON.stringify({ sessionId: ID, viewId: VIEW }), 'the key waits for the page');

    // The Live Sessions page the host opens reads the stored key itself and re-attaches with a fresh attach token.
    globalThis.assistOS.user = { roles: ['admin'] };
    const frameHost = page.elements.get('#liveSessionsFrame');
    const panel = page.newPage();
    panel.afterRender();
    await settle();
    const posts = page.calls.filter((call) => call.method === 'POST');
    // The recovered view is named in the claim, and nothing else is.
    assert.deepEqual(posts, [{ url: `/webtty/live-sessions/${ID}/attach-tokens`, method: 'POST', body: JSON.stringify({ supersedes: VIEW }) }]);
    assert.equal(frameHost.children[0].src, `/webtty/#attach=${TOKEN}`);
    assert.equal(panel.viewerId, ID);
    assert.equal(panel.restore, null, 'the restore request is consumed once');

    // A second toolbar mount in the same page does not read again.
    const again = new LiveSessionsToolButton(page.host, () => {});
    t.after(() => again.afterUnload());
    again.afterRender();
    await settle();
    assert.equal(page.calls.filter((call) => call.url === '/webtty/live-sessions' && call.method === 'GET').length, 2, 'start read plus the panel read only');
});

test('Explorer start clears the key when the session is gone, exited or not owned, and opens nothing', async (t) => {
    for (const rows of [
        [], [tombstone()], [unattended({ isOwner: false, capabilities: { watch: true, input: false, stop: true, message: false } })],
        [unattended({ id: SECOND_ID })],
    ]) {
        const page = startupEnvironment(t, { rows });
        page.toolButton.afterRender();
        await settle();
        assert.equal(page.calls.length, 1);
        assert.deepEqual(page.opened, []);
        assert.equal(page.storage.data.size, 0, 'the stale key is cleared');
        page.toolButton.afterUnload();
    }
});

test('Explorer start without a stored terminal still reads once for the badge and opens nothing', async (t) => {
    const page = startupEnvironment(t, { key: null, rows: [unattended(), unattended({ id: SECOND_ID, ownerViewOpen: true })] });
    page.toolButton.afterRender();
    await settle();
    assert.equal(page.calls.length, 1);
    assert.equal(page.badge.textContent, '1');
    assert.deepEqual(page.opened, []);
    const garbage = startupEnvironment(t, { key: null });
    garbage.storage.setItem(EMBEDDED_TERMINAL_KEY, '{"sessionId":"x","extra":1}');
    garbage.toolButton.afterRender();
    await settle();
    assert.deepEqual(garbage.opened, []);
});

test('Explorer start for a non-administrator, a failed read, or a panel closed meanwhile reads nothing or restores nothing', async (t) => {
    const user = startupEnvironment(t, { admin: false });
    user.toolButton.afterRender();
    user.toolButton.updateHostContext({});
    await settle();
    assert.deepEqual(user.calls, []);
    assert.deepEqual(user.opened, []);

    const failed = startupEnvironment(t, { fetchImpl: async () => response({}, 503) });
    failed.toolButton.afterRender();
    await settle();
    assert.deepEqual(failed.opened, []);
    assert.equal(failed.storage.data.size, 0);

    let release;
    const closing = startupEnvironment(t, {
        fetchImpl: async () => { await new Promise((resolve) => { release = resolve; }); return response(payload([unattended()])); },
    });
    closing.toolButton.afterRender();
    await settle();
    clearEmbeddedTerminalKey();
    release();
    await settle();
    assert.deepEqual(closing.opened, [], 'closing the panel during the read wins over the restore');
    assert.equal(closing.storage.data.size, 0);
});

test('the return cue counts owned unattended stop-policy shells and unconfirmed tombstones, and adds no timer', async (t) => {
    const owned = unattended();
    assert.equal(countNeedsAttention([
        owned,
        unattended({ id: '1'.repeat(32), pendingStopUntil: 9000 }),
        unattended({ id: '2'.repeat(32), ownerViewOpen: true }),
        row({ id: '3'.repeat(32), closePolicy: 'keep', ownerViewOpen: false, pendingStopUntil: null }),
        unattended({ id: '4'.repeat(32), isOwner: false, capabilities: { watch: true, input: false, stop: true, message: false } }),
        row({ id: '5'.repeat(32) }),
        tombstone({ id: '6'.repeat(32), closure: 'unconfirmed', closureScope: 'provider' }),
        tombstone({ id: '7'.repeat(32), closure: 'unconfirmed' }),
        tombstone({ id: 'c'.repeat(32), closure: 'unconfirmed', closureScope: 'global', isOwner: false, capabilities: { watch: true, input: false, stop: true, message: false } }),
        tombstone({ id: '8'.repeat(32), closure: 'proven' }),
        tombstone({ id: '9'.repeat(32), closure: 'pending' }),
        tombstone({ id: 'a'.repeat(32), closure: undefined }),
        tombstone({ id: 'b'.repeat(32), closure: 'proven', closePolicy: 'stop', ownerViewOpen: false }),
    ]), 5);
    assert.equal(countNeedsAttention([]), 0);

    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const page = startupEnvironment(t, { key: null, rows: [owned] });
    page.toolButton.afterRender();
    await settle();
    assert.equal(page.badge.textContent, '1');
    assert.match(page.button['aria-label'] || '', /1 to review/);
    t.mock.timers.tick(120_000);
    await settle();
    assert.equal(page.calls.length, 1, 'start schedules no poller of its own');

    // The panel's existing five-second poll refreshes the badge.
    page.modal.afterRender();
    await settle();
    assert.equal(page.calls.length, 2);
    page.modal.rows.clear();
    const fetched = [unattended(), unattended({ id: SECOND_ID }), unattended({ id: 'T'.repeat(32), ownerViewOpen: true })];
    globalThis.fetch = async () => response(payload(fetched));
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(page.badge.textContent, '2');
    fetched.length = 0;
    t.mock.timers.tick(5000);
    await settle();
    assert.equal(page.badge.hidden, true);
    assert.equal(currentCue(), 0);
    publishCue(150);
    assert.equal(page.badge.textContent, '99+');
});

test('mountOnStart is opt-in per plugin, boolean only, and set only by Live Sessions', async () => {
    const pluginsRoot = path.join(root, 'IDE-plugins');
    const optedIn = [];
    for (const name of await fs.readdir(pluginsRoot)) {
        const config = JSON.parse(await fs.readFile(path.join(pluginsRoot, name, 'config.json'), 'utf8').catch(() => 'null') || 'null');
        if (config && Object.hasOwn(config, 'mountOnStart')) optedIn.push([name, config.mountOnStart]);
    }
    assert.deepEqual(optedIn, [['live-sessions', true]]);

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mount-on-start-'));
    const declare = async (name, extra) => {
        const folder = path.join(directory, 'sample', 'IDE-plugins', name);
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, 'config.json'), JSON.stringify({
            pluginCategory: 'application', id: name, component: `sample-${name}`, location: ['file-exp:toolbar'], ...extra,
        }));
    };
    try {
        await declare('absent', {});
        await declare('on', { mountOnStart: true });
        await declare('off', { mountOnStart: false });
        for (const [name, value] of [['string', 'true'], ['number', 1], ['null', null], ['object', {}], ['array', [true]]]) {
            await declare(`bad-${name}`, { mountOnStart: value });
        }
        const catalog = await aggregateIdePlugins(directory);
        const found = catalog.application['file-exp:toolbar'];
        assert.deepEqual(found.map((entry) => entry.id).sort(), ['absent', 'off', 'on'], 'non-boolean values are rejected on the server');
        const normalized = normalizeRuntimePlugins(catalog).application['file-exp:toolbar'];
        assert.deepEqual(Object.fromEntries(normalized.map((entry) => [entry.id, entry.mountOnStart])), { absent: false, off: false, on: true });
        // The browser repeats the check for catalogs it did not build itself.
        for (const bad of ['true', 1, null, {}, []]) {
            const entry = { ...found.find((candidate) => candidate.id === 'on'), mountOnStart: bad };
            assert.equal(normalizeRuntimePlugins({ application: { 'file-exp:toolbar': [entry] } }).application['file-exp:toolbar'].length, 0, JSON.stringify(bad));
        }
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('the start work runs once when the opted-in toolbar button mounts, however often it renders or gets context', async (t) => {
    const page = startupEnvironment(t, { key: null, rows: [unattended()] });
    page.toolButton.afterRender();
    page.toolButton.afterRender();
    page.toolButton.updateHostContext(HOST_CONTEXT);
    await settle();
    page.toolButton.afterRender();
    page.toolButton.updateHostContext(HOST_CONTEXT);
    await settle();
    assert.deepEqual(page.calls, [{ url: '/webtty/live-sessions', method: 'GET' }]);
    assert.equal(page.button.hidden, false, 'the mounted button is visible');
    assert.equal(page.badge.textContent, '1');
});

// ---------------------------------------------------------------------------------------------------------------
// Addendum A1 (explicit recovery supersession): A11-S.
// ---------------------------------------------------------------------------------------------------------------

test('A11-S: the attach-token body is exactly {} or exactly {supersedes}, and a bad claim sends nothing', async () => {
    const bodies = [];
    const fetchImpl = async (_url, request) => {
        bodies.push(request.body);
        return response({ ok: true, attach: TOKEN, expiresAt: Date.now() + 60000 }, 201);
    };
    assert.equal(await mintLiveSessionAttach(ID, { fetchImpl }), TOKEN);
    assert.equal(await mintLiveSessionAttach(ID, { fetchImpl, supersedes: VIEW }), TOKEN);
    assert.deepEqual(bodies, ['{}', JSON.stringify({ supersedes: VIEW })]);
    assert.deepEqual(Object.keys(JSON.parse(bodies[1])), ['supersedes']);
    for (const supersedes of ['short', 'V'.repeat(33), 'V'.repeat(31), 'bad id'.padEnd(32, 'x'), '', null, 7, {}, ['V'.repeat(32)]]) {
        await assert.rejects(mintLiveSessionAttach(ID, { fetchImpl, supersedes }), /Invalid superseded view/, String(supersedes));
    }
    assert.equal(bodies.length, 2, 'rejected claims never reach the network');
});

test('A11-S: the embedded key is exactly {sessionId, viewId} and is rewritten on every validated announcement', async (t) => {
    const page = embeddedEnvironment(t);
    const writes = [];
    const setItem = page.storage.setItem;
    page.storage.setItem = (key, value) => { writes.push([key, value]); setItem(key, value); };
    page.modal.afterRender();
    await settle();
    await page.modal.performAction(ID, 'attach');
    page.frame().contentWindow = { name: 'frame' };

    page.announce({ viewId: 'A'.repeat(32), policy: 'stop' });
    page.announce({ viewId: 'B'.repeat(32), policy: 'keep' });
    page.announce({ viewId: 'B'.repeat(32), policy: 'keep' });
    page.announce({ viewId: 'C'.repeat(32), policy: 'stop' });
    assert.deepEqual(writes, [
        [EMBEDDED_TERMINAL_KEY, JSON.stringify({ sessionId: ID, viewId: 'A'.repeat(32) })],
        [EMBEDDED_TERMINAL_KEY, JSON.stringify({ sessionId: ID, viewId: 'B'.repeat(32) })],
        [EMBEDDED_TERMINAL_KEY, JSON.stringify({ sessionId: ID, viewId: 'B'.repeat(32) })],
        [EMBEDDED_TERMINAL_KEY, JSON.stringify({ sessionId: ID, viewId: 'C'.repeat(32) })],
    ]);
    assert.deepEqual(readEmbeddedTerminalKey(), { sessionId: ID, viewId: 'C'.repeat(32) });
    assert.equal(page.win.count('pagehide'), 1);

    // Rejected announcements write nothing.
    page.announce({ viewId: 'D'.repeat(33) });
    page.announce({ viewId: 'short' });
    page.announce({ role: 'watcher' });
    page.announce({ sessionId: SECOND_ID });
    page.announce({}, { origin: 'https://evil.test' });
    assert.equal(writes.length, 4);
    assert.equal(readEmbeddedTerminalKey().viewId, 'C'.repeat(32));
});

test('A11-S: a legacy, malformed or unreadable key is absent, and a bad write stores nothing', (t) => {
    const storage = memoryStorage();
    const previous = globalThis.sessionStorage;
    globalThis.sessionStorage = storage;
    t.after(() => { globalThis.sessionStorage = previous; });
    const good = JSON.stringify({ sessionId: ID, viewId: VIEW });
    storage.setItem(EMBEDDED_TERMINAL_KEY, good);
    assert.deepEqual(readEmbeddedTerminalKey(), { sessionId: ID, viewId: VIEW });
    assert.equal(storage.data.get(EMBEDDED_TERMINAL_KEY), good, 'a valid key is left in place');

    for (const value of [
        JSON.stringify({ sessionId: ID }), // the earlier shape
        JSON.stringify({ sessionId: ID, viewId: 'short' }), JSON.stringify({ sessionId: ID, viewId: 'V'.repeat(33) }),
        JSON.stringify({ sessionId: 'short', viewId: VIEW }), JSON.stringify({ sessionId: ID, viewId: VIEW, extra: 1 }),
        JSON.stringify({ sessionId: ID, viewId: 7 }), JSON.stringify([ID, VIEW]), JSON.stringify(ID), 'null', '{not json', '',
    ]) {
        storage.setItem(EMBEDDED_TERMINAL_KEY, value);
        assert.equal(readEmbeddedTerminalKey(), null, value);
        assert.equal(storage.data.has(EMBEDDED_TERMINAL_KEY), false, `${value} is cleared`);
    }
    assert.equal(readEmbeddedTerminalKey(), null);

    writeEmbeddedTerminalKey(ID, 'short');
    writeEmbeddedTerminalKey('short', VIEW);
    writeEmbeddedTerminalKey(ID, undefined);
    assert.equal(storage.data.size, 0);
    writeEmbeddedTerminalKey(ID, VIEW);
    assert.equal(storage.data.get(EMBEDDED_TERMINAL_KEY), good);

    globalThis.sessionStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    assert.equal(readEmbeddedTerminalKey(), null);
    writeEmbeddedTerminalKey(ID, VIEW);
    clearEmbeddedTerminalKey();
});

test('A11-S: Explorer start with a legacy key restores nothing and clears it', async (t) => {
    const page = startupEnvironment(t, { key: { sessionId: ID }, rows: [unattended()] });
    page.toolButton.afterRender();
    await settle();
    assert.deepEqual(page.calls.map((call) => call.method), ['GET']);
    assert.deepEqual(page.opened, []);
    assert.equal(page.storage.data.size, 0);
    assert.equal(page.newPage().restore, null, 'a page started afterwards finds no key');
});

test('A11-S: only the Explorer restore names a superseded view; plain attach and pop-out send {}', async (t) => {
    const page = embeddedEnvironment(t);
    globalThis.window.open = () => ({
        opener: {}, close() {}, document: { createElement: () => ({ click() {} }), body: { appendChild() {} } },
    });
    page.modal.afterRender();
    await settle();
    const mintBodies = () => page.calls.filter((call) => call.url.endsWith('/attach-tokens')).map((call) => call.options.body);

    await page.modal.performAction(ID, 'attach');
    await page.modal.performAction(ID, 'pop-out');
    assert.deepEqual(mintBodies(), ['{}', '{}']);
    // Even a caller that tries to pass a claim cannot make pop-out or transcript carry one.
    await page.modal.performAction(ID, 'pop-out', { supersedes: VIEW });
    assert.deepEqual(mintBodies(), ['{}', '{}', '{}']);
    // A restore is a plain attach that names the recovered view, read from the stored key when the page starts.
    writeEmbeddedTerminalKey(ID, VIEW);
    const restored = new LiveSessionsModal(Object.assign(new Element(), { querySelector: (selector) => page.elements.get(selector) }), () => {});
    t.after(() => restored.afterUnload());
    restored.afterRender();
    await settle();
    assert.deepEqual(mintBodies(), ['{}', '{}', '{}', JSON.stringify({ supersedes: VIEW })]);
    assert.equal(restored.viewerId, ID);
});

// ---------------------------------------------------------------------------------------------------------------
// The panel is the Live Sessions page in an iframe: it reaches the Explorer shell only through the bridge.
// ---------------------------------------------------------------------------------------------------------------

function parentWindow() {
    const messages = [];
    return { messages, postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); } };
}

// A shell window whose document holds the expanded modal's dialog around the Live Sessions iframe, plus other frames.
function shellWindow(t) {
    const win = fakeWindow();
    const panel = { name: 'panel' };
    const other = { name: 'another expanded panel' };
    const bare = { name: 'a frame outside any dialog' };
    const listeners = [];
    const dialog = {
        dataset: { expandedKey: PAGE_URL },
        addEventListener(type, handler, options) { listeners.push({ type, handler, once: options?.once === true }); },
        // The expanded modal closes the dialog and then removes it, taking its iframe out of the document.
        close() {
            frames.splice(frames.indexOf(panelFrame), 1);
            for (const { type, handler } of listeners.splice(0)) if (type === 'close') handler({ type });
        },
        listenerCount: () => listeners.length,
    };
    const panelFrame = { contentWindow: panel, closest: (selector) => (selector === 'dialog' ? dialog : null) };
    const frames = [
        { contentWindow: bare, closest: () => null },
        { contentWindow: other, closest: () => ({ dataset: { expandedKey: '/base-agent-additional-server/roboTeamAgent/3001/' } }) },
        panelFrame,
    ];
    win.document = { querySelectorAll: (selector) => (selector === 'iframe' ? frames : []) };
    const previous = new Map(['window', 'fetch', 'sessionStorage', 'document'].map((key) => [key, globalThis[key]]));
    t.after(() => { for (const [key, value] of previous) globalThis[key] = value; publishCue(0); });
    globalThis.window = win;
    globalThis.sessionStorage = memoryStorage();
    globalThis.document = { cookie: 'ploinky_browser_csrf=v1.shell-proof' };
    const calls = [];
    globalThis.fetch = async (url, options) => { calls.push({ url, options }); return response({ ok: true }, 202); };
    publishCue(0);
    return { win, panel, other, bare, calls, dialog, frames, panelFrame };
}

const cueMessage = (count) => ({ type: CUE_MESSAGE, count });
const viewMessage = (view) => ({ type: BRIDGE_VIEW_MESSAGE, view });
const goodView = (changes = {}) => ({ sessionId: ID, viewId: VIEW, policy: 'stop', ...changes });

test('bridge messages have exact shapes: a cue count, or a null or exact {sessionId, viewId, policy} view', () => {
    assert.deepEqual(parseBridgeMessage(cueMessage(0)), cueMessage(0));
    assert.deepEqual(parseBridgeMessage(cueMessage(7)), cueMessage(7));
    assert.deepEqual(parseBridgeMessage(viewMessage(null)), viewMessage(null));
    assert.deepEqual(parseBridgeMessage(viewMessage(goodView())), viewMessage(goodView()));
    assert.deepEqual(parseBridgeMessage(viewMessage(goodView({ policy: 'keep' }))), viewMessage(goodView({ policy: 'keep' })));
    for (const bad of [
        null, undefined, 'x', [], {}, { type: CUE_MESSAGE }, { type: 'other', count: 1 },
        { ...cueMessage(1), extra: 1 }, cueMessage(-1), cueMessage(1.5), cueMessage('1'), cueMessage(Number.NaN), cueMessage(2 ** 60),
        { type: BRIDGE_VIEW_MESSAGE }, { ...viewMessage(null), extra: 1 }, viewMessage(undefined), viewMessage('view'), viewMessage([]),
        viewMessage({ ...goodView(), extra: 1 }), viewMessage({ sessionId: ID, viewId: VIEW }),
        viewMessage(goodView({ sessionId: 'short' })), viewMessage(goodView({ sessionId: 'bad id'.padEnd(32, 'x') })),
        viewMessage(goodView({ viewId: 'short' })), viewMessage(goodView({ viewId: 'V'.repeat(33) })),
        viewMessage(goodView({ policy: 'later' })), viewMessage(goodView({ policy: undefined })),
    ]) assert.equal(parseBridgeMessage(bad), null, JSON.stringify(bad));
});

test('the page reports to the shell only when it is framed, naming the shell origin', () => {
    const alone = fakeWindow();
    alone.parent = alone;
    assert.equal(hostWindow(alone), null);
    assert.equal(postCueToHost(2, alone), false);
    assert.equal(postViewToHost(null, alone), false);
    assert.equal(hostWindow({ location: { origin: ORIGIN } }), null, 'a window with no parent is not framed');

    const framed = fakeWindow();
    const parent = parentWindow();
    framed.parent = parent;
    assert.equal(hostWindow(framed), parent);
    assert.equal(postCueToHost(2, framed), true);
    assert.equal(postViewToHost(goodView(), framed), true);
    assert.equal(postViewToHost(null, framed), true);
    assert.deepEqual(parent.messages, [
        { message: cueMessage(2), targetOrigin: ORIGIN },
        { message: viewMessage(goodView()), targetOrigin: ORIGIN },
        { message: viewMessage(null), targetOrigin: ORIGIN },
    ]);
});

test('the shell bridge takes the cue and the view only from the Live Sessions panel iframe of this origin', async (t) => {
    const { win, panel, other, bare, calls } = shellWindow(t);
    const bridge = installHostBridge(win);
    assert.equal(installHostBridge(win), bridge, 'one bridge per Explorer window');
    bridge.setPageUrl(PAGE_URL);
    const send = (data, event = {}) => win.dispatch('message', { source: panel, origin: ORIGIN, data, ...event });

    send(cueMessage(3));
    assert.equal(currentCue(), 3);
    for (const event of [
        { source: other }, { source: bare }, { source: null }, { source: undefined }, { source: { name: 'unknown window' } },
        { origin: 'https://evil.test' }, { origin: 'null' }, { origin: undefined },
    ]) {
        send(cueMessage(9), event);
        send(viewMessage(goodView()), event);
    }
    send(cueMessage(-1));
    send({ ...cueMessage(8), extra: 1 });
    assert.equal(currentCue(), 3, 'forged and malformed cues change nothing');
    win.dispatch('pagehide', {});
    assert.deepEqual(calls, [], 'a forged view registers no close intent');

    bridge.setPageUrl('/another/page.html');
    send(cueMessage(5));
    assert.equal(currentCue(), 3, 'a panel opened for a different page is not trusted');
    bridge.setPageUrl(PAGE_URL);
    send(cueMessage(0));
    assert.equal(currentCue(), 0);
});

test('only the shell sends the close intent, once for the reported view, when the whole Explorer tab unloads', async (t) => {
    const { win, panel, calls } = shellWindow(t);
    const bridge = installHostBridge(win);
    bridge.setPageUrl(PAGE_URL);
    const send = (data) => win.dispatch('message', { source: panel, origin: ORIGIN, data });

    win.dispatch('pagehide', {});
    assert.deepEqual(calls, [], 'no embedded terminal, no signal');

    send(viewMessage(goodView({ viewId: 'A'.repeat(32), policy: 'keep' })));
    send(viewMessage(goodView({ viewId: 'B'.repeat(32), policy: 'stop' })));
    send(viewMessage(goodView({ viewId: 'bad' })));
    win.dispatch('pagehide', { persisted: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/webtty/sessions/${ID}/close-intents`);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.keepalive, true);
    assert.equal(calls[0].options.headers['X-Ploinky-Browser-CSRF-Token'], 'v1.shell-proof');
    assert.deepEqual(JSON.parse(calls[0].options.body), { view: 'B'.repeat(32), policy: 'stop' }, 'the latest valid view and its policy');

    // A detach in the page, or the page closing the panel, leaves nothing to signal.
    send(viewMessage(null));
    win.dispatch('pagehide', {});
    assert.equal(calls.length, 1);
    send(viewMessage(goodView()));
    writeEmbeddedTerminalKey(ID, VIEW);
    bridge.panelClosed();
    win.dispatch('pagehide', {});
    assert.equal(calls.length, 1, 'closing the panel only detaches: it never stops a shell');
    assert.equal(readEmbeddedTerminalKey(), null, 'a later Explorer start must not restore the detached view');
});

test('a page inside the Explorer panel hands its terminal view to the shell instead of signalling on its own pagehide', async (t) => {
    const page = embeddedEnvironment(t);
    const shell = parentWindow();
    page.win.parent = shell;
    page.modal.afterRender();
    await settle();
    await page.modal.performAction(ID, 'attach');
    page.frame().contentWindow = { name: 'terminal frame' };
    const posted = () => shell.messages.map((entry) => entry.message);

    // The list read reported the cue (one unattended Stop-it shell) to the shell badge.
    assert.deepEqual(posted(), [cueMessage(1)]);
    page.announce();
    assert.deepEqual(posted().at(-1), viewMessage(goodView()));
    assert.ok(shell.messages.every((entry) => entry.targetOrigin === ORIGIN));
    assert.equal(page.win.count('pagehide'), 0, 'the panel being closed is not the Explorer tab closing');
    assert.equal(page.storage.data.get(EMBEDDED_TERMINAL_KEY), JSON.stringify({ sessionId: ID, viewId: VIEW }), 'the key stays for an Explorer reload');
    const before = page.calls.length;
    page.win.dispatch('pagehide', {});
    assert.equal(page.calls.length, before, 'this page sends no close intent');

    page.announce({ viewId: 'W'.repeat(32), policy: 'keep' });
    assert.deepEqual(posted().at(-1), viewMessage(goodView({ viewId: 'W'.repeat(32), policy: 'keep' })));

    // Detaching tells the shell to forget the view, so a later Explorer unload signals nothing.
    page.modal.detachViewer();
    assert.deepEqual(posted().at(-1), viewMessage(null));
    assert.equal(page.storage.data.size, 0);
});

test('a page of its own (Open in new tab) is the tab that closes, so it signals on its own pagehide', async (t) => {
    const page = embeddedEnvironment(t);
    page.win.parent = page.win;
    page.modal.afterRender();
    await settle();
    await page.modal.performAction(ID, 'attach');
    page.frame().contentWindow = { name: 'terminal frame' };
    page.announce({ policy: 'stop' });
    assert.equal(page.win.count('pagehide'), 1);
    const before = page.calls.length;
    page.win.dispatch('pagehide', {});
    assert.equal(page.calls.length, before + 1);
    assert.deepEqual(JSON.parse(page.calls.at(-1).options.body), { view: VIEW, policy: 'stop' });
});

test('the start work waits for the host descriptor, then opens the Live Sessions page once to restore a terminal', async (t) => {
    const page = startupEnvironment(t);
    page.toolButton.hostContext = {};
    page.toolButton.afterRender();
    await settle();
    assert.deepEqual(page.calls, [], 'no descriptor yet: no read and no lost restore');
    assert.deepEqual(page.opened, []);
    assert.equal(page.storage.data.size, 1, 'the key is kept for the start work that follows');

    page.toolButton.updateHostContext(HOST_CONTEXT);
    await settle();
    assert.deepEqual(page.calls, [{ url: '/webtty/live-sessions', method: 'GET' }]);
    assert.deepEqual(page.opened, [{ ...PAGE_DESCRIPTOR, title: 'Live Sessions' }]);
    page.toolButton.updateHostContext(HOST_CONTEXT);
    page.toolButton.afterRender();
    await settle();
    assert.equal(page.opened.length, 1, 'later context updates do not reopen the panel');
});

test('the toolbar click opens the descriptor with the host label; closing the panel forgets the embedded terminal', async (t) => {
    const page = startupEnvironment(t, { key: null });
    page.toolButton.updateHostContext({ ...HOST_CONTEXT, pluginLabel: 'Sessions' });
    await settle();
    page.opened.length = 0;
    page.toolButton.openSessions();
    assert.deepEqual(page.opened, [{ ...PAGE_DESCRIPTOR, title: 'Sessions' }]);

    // The shell holds the view the panel's page reported and the key that restores it after a reload.
    const panel = {};
    page.win.document = { querySelectorAll: () => [{ contentWindow: panel, closest: () => ({ dataset: { expandedKey: PAGE_URL } }) }] };
    page.win.dispatch('message', { source: panel, origin: ORIGIN, data: viewMessage(goodView()) });
    writeEmbeddedTerminalKey(ID, VIEW);
    page.closePanel();
    await settle();
    assert.equal(page.storage.data.size, 0, 'closing the panel clears the key');
    page.calls.length = 0;
    page.win.dispatch('pagehide', {});
    assert.deepEqual(page.calls, [], 'and the view, so an Explorer unload sends nothing');

    // A host without a descriptor or without the expanded modal opens nothing and says so.
    const bare = new LiveSessionsToolButton(new Element(), () => {});
    assert.equal(bare.openPanel(), false);
    bare.hostContext = HOST_CONTEXT;
    const ui = globalThis.assistOS.UI;
    globalThis.assistOS.UI = {};
    assert.equal(bare.openPanel(), false);
    globalThis.assistOS.UI = ui;
});

test('a panel closed by any code leaves nothing to signal: the shell notices the dialog closing and the iframe going away', async (t) => {
    // 1. The dialog closes (the host opened the panel itself, so no presenter promise is involved).
    const first = shellWindow(t);
    const bridge = installHostBridge(first.win);
    bridge.setPageUrl(PAGE_URL);
    first.win.dispatch('message', { source: first.panel, origin: ORIGIN, data: viewMessage(goodView()) });
    first.win.dispatch('message', { source: first.panel, origin: ORIGIN, data: viewMessage(goodView({ policy: 'keep' })) });
    assert.equal(first.dialog.listenerCount(), 1, 'one close watch per dialog, however many views it reports');
    writeEmbeddedTerminalKey(ID, VIEW);
    first.dialog.close();
    assert.equal(readEmbeddedTerminalKey(), null, 'a later Explorer start must not restore the detached view');
    assert.equal(bridge.view, null);
    first.win.dispatch('pagehide', {});
    assert.deepEqual(first.calls, []);

    // 2. The iframe is gone before the tab unloads, even if no close event ever arrived.
    const second = shellWindow(t);
    const other = installHostBridge(second.win);
    other.setPageUrl(PAGE_URL);
    second.win.dispatch('message', { source: second.panel, origin: ORIGIN, data: viewMessage(goodView()) });
    second.frames.splice(second.frames.indexOf(second.panelFrame), 1);
    second.win.dispatch('pagehide', {});
    assert.deepEqual(second.calls, [], 'a missing panel frame never sends a Stop-it signal');

    // 3. With the panel still open the same unload does signal, so the checks above are not vacuous.
    const third = shellWindow(t);
    const live = installHostBridge(third.win);
    live.setPageUrl(PAGE_URL);
    third.win.dispatch('message', { source: third.panel, origin: ORIGIN, data: viewMessage(goodView()) });
    third.win.dispatch('pagehide', {});
    assert.equal(third.calls.length, 1);
    assert.equal(third.calls[0].url, `/webtty/sessions/${ID}/close-intents`);
});
