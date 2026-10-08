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
        document: { createElement: () => ({ isConnected: true }) },
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
        marketplaceEntry: { ref: 'AchillesIDE/webmeetAgent', running: true },
        runtimeReads, order,
        target: async () => { order.push('target'); },
        mcp: async () => { order.push('mcp'); }
    });
    const controller = new AbortController();
    const entry = await p.ensureAgentRuntime('AchillesIDE/webmeetAgent', controller.signal);
    assert.equal(entry.running, true);
    assert.equal(await p.waitForAgent('AchillesIDE/webmeetAgent', p.runId, controller.signal, entry), true);
    assert.equal(runtimeReads.count, 0);
    assert.equal(order[0], 'stability');
});

test('a starting marketplace entry still triggers a runtime re-read', async () => {
    const runtimeReads = { count: 0 };
    const p = waitHarness({
        marketplaceEntry: { ref: 'AchillesIDE/webmeetAgent', running: false },
        runtimeReads, order: [],
        target: async () => {}, mcp: async () => {}
    });
    const controller = new AbortController();
    const entry = await p.ensureAgentRuntime('AchillesIDE/webmeetAgent', controller.signal);
    assert.equal(await p.waitForAgent('AchillesIDE/webmeetAgent', p.runId, controller.signal, entry), true);
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
    const waiting = p.waitForAgent('AchillesIDE/webmeetAgent', p.runId, controller.signal, { running: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['stability', 'target-start', 'mcp-start'], 'MCP starts while the target probe is still pending');
    releaseTarget();
    assert.equal(await waiting, true);
});

test('a failing concurrent probe (permanent error wins) maps to the unavailable state and an abort suppresses it', async () => {
    const states = [];
    const p = waitHarness({
        marketplaceEntry: null, runtimeReads: { count: 0 }, order: [],
        target: async () => { throw Object.assign(new Error('Target rejected'), { status: 403 }); },
        mcp: async () => { throw Object.assign(new Error('MCP warming up'), { status: 503 }); }
    });
    p.setState = message => states.push(message);
    const originalError = console.error;
    console.error = () => {};
    try {
        const controller = new AbortController();
        assert.equal(await p.waitForAgent('AchillesIDE/webmeetAgent', p.runId, controller.signal, { running: true }), false);
        assert.deepEqual(states.slice(-1), ['Target rejected']);
        states.length = 0;
        const aborted = new AbortController();
        aborted.abort();
        await p.waitForAgent('AchillesIDE/webmeetAgent', p.runId, aborted.signal, { running: true });
        assert.equal(states.includes('Target rejected'), false);
    } finally {
        console.error = originalError;
    }
});
