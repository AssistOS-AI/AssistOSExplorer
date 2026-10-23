import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../../web-components/modals/expanded-modal/expanded-modal.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\n/gm, '').replace('export class ExpandedModal', 'class ExpandedModal');
function presenter(extra = {}) {
    const frames = [];
    const context = vm.createContext({ window: { innerWidth: 1200, innerHeight: 800 }, console, AbortController, clearTimeout, requestAnimationFrame: callback => frames.push(callback), setTimeout, ...extra });
    vm.runInContext(`${source}\nthis.Modal = ExpandedModal;`, context);
    const element = { isConnected: true, querySelector: () => ({ textContent: '' }) };
    const modal = new context.Modal(element, () => {});
    modal.paint = () => frames.splice(0).forEach(callback => callback());
    return modal;
}

test('fullscreen restore retains custom size and clamps it to the viewport', () => {
    const p = presenter();
    const classes = new Set();
    p.dialog = {
        dataset: { expandedPositioned: 'true' }, style: {},
        getBoundingClientRect: () => ({ left: 100, top: 80, width: 950, height: 650 }),
        classList: { contains: c => classes.has(c), toggle: (c, yes) => yes ? classes.add(c) : classes.delete(c) }
    };
    p.setFullscreen(true); p.setFullscreen(false);
    assert.equal(p.dialog.style.width, '950px');
    assert.equal(p.dialog.style.height, '650px');
    assert.equal(p.dialog.style.left, '100px');
    p.prevRect = { left: 900, top: 700, width: 1500, height: 1000 };
    p.setFullscreen(false);
    assert.equal(p.dialog.style.width, '1200px');
    assert.equal(p.dialog.style.height, '800px');
    assert.equal(p.dialog.style.left, '0px');
    assert.equal(p.dialog.style.top, '0px');
});

test('only the latest props reach a component after asynchronous mounting', async () => {
    const p = presenter();
    p.initialSizeApplied = true;
    let ready;
    p.contentReady = new Promise(resolve => { ready = resolve; });
    const updates = [];
    p.contentProxy = { element: { deref: () => ({ webSkelPresenter: { updateModalProps: props => updates.push(props) } }) } };
    const a = p.updateDescriptor({ props: { selectedRepoPath: 'a' } });
    const b = p.updateDescriptor({ props: { selectedRepoPath: 'b', openConflictHelper: true } });
    ready(); await Promise.all([a, b]);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].selectedRepoPath, 'b');
});

test('closing during component mounting discards pending property updates', async () => {
    const p = presenter(); p.initialSizeApplied = true;
    let ready;
    p.contentReady = new Promise(resolve => { ready = resolve; });
    const updates = [];
    p.contentProxy = { element: { deref: () => ({ webSkelPresenter: { updateModalProps: props => updates.push(props) } }) } };
    const updating = p.updateDescriptor({ props: { selectedRepoPath: 'a' } });
    p.element.isConnected = false; ready(); await updating;
    assert.equal(updates.length, 0);
});

test('WebSkel host does not display a launch cancelled during rendering', async () => {
    const main = await fs.readFile(new URL('../../main.js', import.meta.url), 'utf8');
    const start = main.indexOf('const openRenderedModal =');
    const end = main.indexOf('webSkel.showModal =', start);
    let rendered;
    const render = new Promise(resolve => { rendered = resolve; });
    const dialog = new EventTarget();
    let shows = 0;
    let removals = 0;
    dialog.showModal = () => { shows++; };
    dialog.remove = () => { removals++; };
    const context = vm.createContext({
        document: { body: { appendChild() {} } },
        waitForModalRender: () => render,
        preventModalEscape() {}
    });
    const open = vm.runInContext(`${main.slice(start, end)}\nopenRenderedModal`, context);
    const abort = new AbortController();
    const pending = open(dialog, abort.signal);
    abort.abort(); rendered(); await pending;
    assert.equal(shows, 0);
    assert.ok(removals > 0);
});


test('plugin work starts only after the open shell can paint', async () => {
    const p = presenter();
    p.setFullscreen = () => {};
    let starts = 0;
    p.startContent = () => { starts++; };
    const updating = p.updateDescriptor({ title: 'Git' });
    assert.equal(starts, 0);
    p.paint(); await updating;
    assert.equal(starts, 1);
});

test('closing before the first paint prevents plugin loading', async () => {
    const p = presenter();
    p.setFullscreen = () => {};
    let starts = 0;
    p.startContent = () => { starts++; };
    const updating = p.updateDescriptor({ title: 'Git' });
    p.element.isConnected = false;
    p.paint(); await updating;
    assert.equal(starts, 0);
});

test('closing aborts pending work, cancels retries and removes the iframe', () => {
    const p = presenter();
    let removed = false;
    let clearedSource = false;
    p.frame = { removeAttribute: () => { clearedSource = true; }, remove: () => { removed = true; } };
    p.retryTimer = setTimeout(() => assert.fail('retry ran after close'), 1000);
    p.afterUnload();
    assert.equal(p.loadController.signal.aborted, true);
    assert.equal(p.retryTimer, null);
    assert.equal(p.frame, null);
    assert.equal(removed, true);
    assert.equal(clearedSource, true);
});

test('closing directly clears the pending readiness timer', async () => {
    const p = presenter();
    const waiting = p.waitForNextProbe(10000);
    p.afterUnload();
    await waiting;
    assert.equal(p.closed, true);
    assert.equal(p.finishWait, null);
});


test('a late component registration cannot mount after close', async () => {
    let registered;
    let mounts = 0;
    const pending = new Promise(resolve => { registered = resolve; });
    const p = presenter({
        document: { createElement: () => ({ isConnected: true, remove() { this.isConnected = false; } }) },
        assistOS: { UI: {
            ensureComponentRegistered: () => pending,
            createElement: () => { mounts++; }
        } }
    });
    p.attr = () => 'git-panel';
    p.componentProps = () => ({});
    p.body = { appendChild() {} };
    p.setState = () => {};
    const loading = p.mountComponentContent();
    p.afterUnload();
    registered(); await loading;
    assert.equal(mounts, 0);
});

const loaderModule = await import('../../shared/ui/agent-runtime-loader/agent-runtime-loader.js');
const wait = await import('../../shared/ui/agent-runtime-loader/agent-runtime-wait-route.js');

function waitHarness({ marketplaceEntry, runtimeReads, order, target, mcp }) {
    const p = presenter({
        URL,
        window: { innerWidth: 1200, innerHeight: 800, location: { origin: 'http://localhost:8080' } },
        assistosSDK: {},
        probeAgentRuntimeRouteStability: async () => { order.push('stability'); },
        probeAgentRuntimeTarget: target,
        probeAgentRuntimeMcp: mcp,
        probeAgentRuntimeTargetAndMcp: wait.probeAgentRuntimeTargetAndMcp,
        readMarketplaceAgent: async () => { runtimeReads.count += 1; return { active: true, running: true }; },
        ensureMarketplaceAgentRunning: async () => marketplaceEntry,
        waitForAgentRuntimeAvailability: loaderModule.waitForAgentRuntimeAvailability
    });
    p.attr = () => 'Panel';
    p.setState = () => {};
    p.frameUrl = () => '/webmeet/';
    p.waitForNextProbe = async () => {};
    return p;
}

test('a running marketplace entry is the first runtime read, so open performs one marketplace read', async () => {
    const runtimeReads = { count: 0 };
    const order = [];
    const p = waitHarness({
        marketplaceEntry: { ref: 'webmeet/webmeetAgent', running: true },
        runtimeReads, order,
        target: async () => { order.push('target'); },
        mcp: async () => { order.push('mcp'); }
    });
    const controller = new AbortController();
    const entry = await p.ensureAgentRuntime('webmeet/webmeetAgent', controller.signal);
    assert.equal(entry.running, true);
    assert.equal(await p.waitForAgent('webmeet/webmeetAgent', p.runId, controller.signal, entry), true);
    assert.equal(runtimeReads.count, 0);
    assert.equal(order[0], 'stability');
});

test('a starting marketplace entry still triggers a runtime re-read', async () => {
    const runtimeReads = { count: 0 };
    const p = waitHarness({
        marketplaceEntry: { ref: 'webmeet/webmeetAgent', running: false },
        runtimeReads, order: [],
        target: async () => {}, mcp: async () => {}
    });
    const controller = new AbortController();
    const entry = await p.ensureAgentRuntime('webmeet/webmeetAgent', controller.signal);
    assert.equal(await p.waitForAgent('webmeet/webmeetAgent', p.runId, controller.signal, entry), true);
    assert.equal(runtimeReads.count, 1);
});

test('target and MCP probes overlap after the stability probe', async () => {
    const order = [];
    let releaseTarget;
    const p = waitHarness({
        marketplaceEntry: null, runtimeReads: { count: 0 }, order,
        target: () => new Promise(resolve => { order.push('target-start'); releaseTarget = resolve; }),
        mcp: async () => { order.push('mcp-start'); }
    });
    const controller = new AbortController();
    const waiting = p.waitForAgent('webmeet/webmeetAgent', p.runId, controller.signal, { running: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['stability', 'target-start', 'mcp-start'], 'MCP starts while the target probe is still pending');
    releaseTarget();
    assert.equal(await waiting, true);
});

test('a failing concurrent probe fails fast despite a hung sibling and maps to the unavailable state and an abort suppresses it', async () => {
    const states = [];
    const p = waitHarness({
        marketplaceEntry: null, runtimeReads: { count: 0 }, order: [],
        target: async () => { throw Object.assign(new Error('Target rejected'), { status: 403 }); },
        mcp: async () => new Promise(() => {})
    });
    p.setState = message => states.push(message);
    const originalError = console.error;
    console.error = () => {};
    try {
        const controller = new AbortController();
        assert.equal(await p.waitForAgent('webmeet/webmeetAgent', p.runId, controller.signal, { running: true }), false);
        assert.deepEqual(states.slice(-1), ['Target rejected']);
        states.length = 0;
        const aborted = new AbortController();
        aborted.abort();
        await p.waitForAgent('webmeet/webmeetAgent', p.runId, aborted.signal, { running: true });
        assert.equal(states.includes('Target rejected'), false);
    } finally {
        console.error = originalError;
    }
});

// ---- Guarded close: a same-origin frame may ask its user before the panel closes or is replaced ----

function guardedFrame(hook) {
    const doc = { title: 'Live Sessions' };
    const contentWindow = { __beforeExpandedModalClose: hook };
    return {
        doc, contentWindow, removed: false,
        get contentDocument() { if (this.unreadable) throw new Error('cross-origin'); return this.doc; },
        removeAttribute() {}, remove() { this.removed = true; },
    };
}

function closingPresenter(hook) {
    const closes = [];
    const p = presenter({ assistOS: { UI: { closeModal: (...args) => closes.push(args) } } });
    p.mode = 'iframe';
    p.frame = guardedFrame(hook);
    const frame = p.frame;
    return { p, frame, closes };
}

test('X waits for the frame guard, shares one preparation, and only a literal true closes', async () => {
    const reasons = [];
    let answer;
    const { p, frame, closes } = closingPresenter((reason) => { reasons.push(reason); return new Promise((resolve) => { answer = resolve; }); });
    const first = p.closeModal();
    const second = p.closeModal();
    const shared = p.prepareClose('replace');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reasons, ['close'], 'one question for concurrent requests');
    assert.equal(closes.length, 0);
    answer(false);
    await Promise.all([first, second]);
    assert.equal(await shared, false);
    assert.equal(closes.length, 0);
    assert.equal(p.closed, false);
    assert.equal(p.frame, frame, 'a refusal keeps the identical frame');
    assert.equal(frame.removed, false);

    for (const result of ['true', 1, {}, undefined, null]) {
        frame.contentWindow.__beforeExpandedModalClose = async () => result;
        await p.closeModal();
        assert.equal(closes.length, 0, JSON.stringify(result));
    }
    const warn = console.warn;
    console.warn = () => {};
    try {
        frame.contentWindow.__beforeExpandedModalClose = async () => { throw new Error('page failed'); };
        await p.closeModal();
        frame.contentWindow.__beforeExpandedModalClose = () => { throw new Error('sync failure'); };
        await p.closeModal();
    } finally {
        console.warn = warn;
    }
    assert.equal(closes.length, 0, 'a failing guard never approves');

    let notified = 0;
    frame.contentWindow.__onExpandedModalClose = async () => { notified += 1; };
    frame.contentWindow.__beforeExpandedModalClose = async (reason) => { reasons.push(reason); return true; };
    await p.closeModal();
    assert.equal(closes.length, 1);
    assert.equal(notified, 1, 'post-approval cleanup still runs');
    assert.equal(p.closed, true);
    assert.equal(frame.removed, true);
});

test('a frame without a guard closes as before, and a component panel keeps its own discard check', async () => {
    const { p, closes } = closingPresenter(undefined);
    delete p.frame.contentWindow.__beforeExpandedModalClose;
    assert.equal(p.hasCloseGuard(), false);
    await p.closeModal();
    assert.equal(closes.length, 1);

    const component = presenter({ assistOS: { UI: { closeModal: (...args) => closes.push(args) } } });
    component.mode = 'component';
    let allow = false;
    component.contentProxy = { element: { deref: () => ({ webSkelPresenter: { confirmDiscardChanges: () => allow } }) } };
    await component.closeModal();
    assert.equal(closes.length, 1);
    allow = true;
    await component.closeModal();
    assert.equal(closes.length, 2);
});

test('a document that offered the guard cannot approve by losing the hook or its readability; a new document can', async () => {
    const { p, frame, closes } = closingPresenter(async () => false);
    p.observeFrameGuard();
    assert.equal(p.hasCloseGuard(), true);
    delete frame.contentWindow.__beforeExpandedModalClose;
    assert.equal(p.hasCloseGuard(), true, 'the same document lost its hook');
    assert.equal(await p.prepareClose('close'), false);
    frame.unreadable = true;
    assert.equal(p.hasCloseGuard(), true, 'the guarded document became unreadable');
    await p.closeModal();
    assert.equal(closes.length, 0);
    // A newly loaded document without the guard is an ordinary page again.
    frame.unreadable = false;
    frame.doc = { title: 'Another page' };
    p.observeFrameGuard();
    assert.equal(p.hasCloseGuard(), false);
    await p.closeModal();
    assert.equal(closes.length, 1);
});

test('reloading or removing the frame while its guard is still asking answers false without waiting for it', async () => {
    const { p, closes } = closingPresenter(() => new Promise(() => {}));
    const closing = p.closeModal();
    await new Promise((resolve) => setImmediate(resolve));
    p.cancelLoading();
    await closing;
    assert.equal(closes.length, 0);
    assert.equal(p.closePreparation, null);
    assert.equal(p.closing, false, 'X works again afterwards');
});

test('a native dialog cancel cannot remove a guarded frame without asking; other dialogs keep their native cancel', async () => {
    let asked = 0;
    const { p, closes } = closingPresenter(async () => { asked += 1; return false; });
    p.dialog = { id: 'host' };
    const event = (target) => ({ target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
    const own = event(p.dialog);
    p.handleDialogCancel(own);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(own.defaultPrevented, true);
    assert.equal(asked, 1);
    assert.equal(closes.length, 0);
    const nested = event({ id: 'nested' });
    p.handleDialogCancel(nested);
    assert.equal(nested.defaultPrevented, false);
    delete p.frame.contentWindow.__beforeExpandedModalClose;
    p.guardedDocuments = new WeakSet();
    p.frameGuarded = false;
    const plain = event(p.dialog);
    p.handleDialogCancel(plain);
    assert.equal(plain.defaultPrevented, false, 'an unguarded panel is unchanged');
});
