import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { aggregateIdePlugins } from '../../utils/ide-plugins.mjs';
import { normalizeRuntimePlugins } from '../../utils/pluginUtils.core.js';
import { openExpandedModal } from '../../shared/ui/expanded-modal.js';
import { LiveSessionsToolButton } from '../../IDE-plugins/live-sessions/live-sessions-tool-button.js';
import { LiveSessionsModal } from '../../IDE-plugins/live-sessions/components/live-sessions-modal/live-sessions-modal.js';
import { killLiveSession, listLiveSessions, mintLiveSessionAttach, normalizeLiveSessionsPayload } from '../../IDE-plugins/live-sessions/live-sessions-api.js';

const ID = 'S'.repeat(32);
const TOKEN = 'T'.repeat(32);
const root = path.resolve(import.meta.dirname, '../..');

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
    assert.deepEqual(config.toolbarModal, { mode: 'component', component: 'live-sessions-modal', fullscreen: true });
    const catalog = normalizeRuntimePlugins(await aggregateIdePlugins(path.resolve(root, '..')));
    const plugin = catalog.application['file-exp:toolbar'].find((entry) => entry.id === 'live-sessions');
    assert.ok(plugin);
    assert.equal(plugin.agent, 'explorer');
    assert.equal(plugin.component, 'live-sessions-tool-button');
    assert.equal(plugin.dependencies[0].component, 'live-sessions-modal');
    assert.equal(plugin.adminOnly, false);
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
    for (const body of [{ ok: true, attach: 'bad', expiresAt: Date.now() + 1000 }, { ok: true, attach: TOKEN, expiresAt: 1 }, { ok: true, attach: TOKEN, expiresAt: Date.now() + 1000, extra: true }]) {
        await assert.rejects(mintLiveSessionAttach(ID, { fetchImpl: async () => response(body, 201) }), /Invalid/);
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
    assert.equal(modal.viewerId, '');
    assert.equal(unloads, 3);
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
