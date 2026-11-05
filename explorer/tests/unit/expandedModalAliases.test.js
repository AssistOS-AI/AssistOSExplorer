import test from 'node:test';
import assert from 'node:assert/strict';

// Distinct ESM identities evaluate the actual source twice, as /shared/ and /explorer/shared/ do in the browser.
const shared = await import('../../shared/ui/expanded-modal.js?alias=shared');
const explorer = await import('../../shared/ui/expanded-modal.js?alias=explorer');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const RESUME_KEY = 'explorer.expandedModal.resume';
const LIVE_URL = '/explorer/IDE-plugins/live-sessions/live-sessions-page.html';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function settled(promise) {
    let result = { settled: false };
    Promise.resolve(promise).then((value) => { result = { settled: true, value }; });
    await tick();
    assert.equal(result.settled, true, 'the launch promise must settle without another request');
    return result.value;
}

function host(t, { ready } = {}) {
    const previous = new Map(['document', 'window', 'assistOS', 'sessionStorage'].map((key) => [key, globalThis[key]]));
    const calls = [];
    const updates = [];
    const errors = [];
    const data = new Map();
    const storage = {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: (key) => data.delete(key),
    };
    const win = new EventTarget();
    const listeners = [];
    const add = win.addEventListener.bind(win);
    win.addEventListener = (type, callback, options) => { listeners.push(type); add(type, callback, options); };
    win.sessionStorage = storage;
    const document = { defaultView: win };
    win.document = document;
    const ui = {
        ensureExpandedModalReady: ready,
        showModal(name, payload, expectResult, { signal }) {
            const render = deferred();
            const dialog = new EventTarget();
            dialog.removals = 0;
            dialog.closes = 0;
            dialog.close = () => { dialog.closes += 1; dialog.dispatchEvent(new Event('close')); };
            dialog.remove = () => { dialog.removals += 1; };
            const presenter = { updateDescriptor: (descriptor) => updates.push(descriptor) };
            dialog.querySelector = () => ({ webSkelPresenter: presenter });
            const call = { name, payload, expectResult, signal, dialog, presenter, ...render };
            calls.push(call);
            return render.promise;
        },
    };
    const activate = () => {
        Object.assign(globalThis, { document, window: win, sessionStorage: storage, assistOS: { UI: ui } });
    };
    activate();
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    t.after(() => {
        for (const call of calls) if (!call.signal.aborted) call.dialog.close();
        for (const [key, value] of previous) {
            if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
        }
        console.error = originalError;
    });
    return { calls, updates, errors, data, storage, document, win, listeners, ui, activate };
}

async function mount(h, index = h.calls.length - 1) {
    h.calls[index].resolve(h.calls[index].dialog);
    await tick();
    return h.calls[index];
}

function guard(call) {
    const answer = deferred();
    const reasons = [];
    Object.assign(call.presenter, {
        hasCloseGuard: () => true,
        prepareClose: (reason) => { reasons.push(reason); return answer.promise; },
    });
    return { ...answer, reasons };
}

test('both ESM aliases share a pending Live Sessions launch, its mounted frame and merged properties', async (t) => {
    const ready = deferred();
    const h = host(t, { ready: () => ready.promise });
    const keysBefore = Object.keys(h.document);
    const first = shared.openExpandedModal({ url: LIVE_URL, title: 'Live Sessions', props: { count: 1, enabled: false } });
    const second = explorer.openExpandedModal({ url: LIVE_URL, props: { count: 2, selected: 'shell' } });
    assert.equal(first, second, 'the two module evaluations must return the identical close promise');
    assert.equal(first.isClosed(), false);
    await tick();
    assert.equal(h.calls.length, 0, 'preload still owns the wait');
    assert.deepEqual(Object.keys(h.document), keysBefore, 'coordination adds no enumerable document property');
    ready.resolve();
    await tick();
    assert.equal(h.calls.length, 1, 'one toolbar target creates exactly one dialog');
    const call = await mount(h);
    assert.equal(await first.opened, call.dialog);
    assert.equal(call.expectResult, false);
    assert.equal(call.payload.url, LIVE_URL);
    assert.deepEqual(h.updates.at(-1).props, { count: 2, enabled: false, selected: 'shell' });
    assert.equal(explorer.openExpandedModal({ url: LIVE_URL, title: 'Sessions', props: { count: 3 } }), first);
    assert.equal(h.calls.length, 1, 'mounted reuse retains the same dialog and presenter');
    assert.equal(h.updates.at(-1).title, 'Sessions');
    assert.deepEqual(h.updates.at(-1).props, { count: 3, enabled: false, selected: 'shell' });
    assert.deepEqual(h.listeners, ['pagehide', 'beforeunload'], 'both aliases install one pair of document window listeners');
    call.dialog.close();
    await settled(first);
    assert.equal(first.isClosed(), true);
});

test('same-key calls also coalesce while showModal is still rendering', async (t) => {
    const h = host(t);
    const first = shared.openExpandedModal({ component: 'git-panel', props: { repo: 'a' } });
    await tick();
    assert.equal(explorer.openExpandedModal({ component: 'git-panel', props: { repo: 'b' } }), first);
    assert.equal(h.calls.length, 1);
    await mount(h);
    assert.equal(h.updates.at(-1).props.repo, 'b');
});

test('cross-alias A to B to C keeps A until approval, cancels C and shares repeated B', async (t) => {
    const h = host(t);
    const a = shared.openExpandedModal({ url: '/a', resume: true });
    await tick();
    const callA = await mount(h);
    const answer = guard(callA);
    const saved = h.data.get(RESUME_KEY);
    const b = explorer.openExpandedModal({ url: '/b', resume: true, props: { page: 1 } });
    const c = shared.openExpandedModal({ url: '/c' });
    assert.equal(await settled(c.opened), null);
    await settled(c);
    assert.equal(c.isClosed(), true);
    assert.equal(shared.openExpandedModal({ url: '/b', props: { page: 2 } }), b);
    await tick();
    assert.deepEqual(answer.reasons, ['replace']);
    assert.equal(h.calls.length, 1);
    assert.equal(callA.dialog.removals, 0);
    assert.equal(h.data.get(RESUME_KEY), saved);
    answer.resolve(true);
    await settled(a);
    assert.equal(h.calls.length, 2);
    const callB = await mount(h);
    assert.equal(await b.opened, callB.dialog);
    assert.equal(JSON.parse(callB.payload.props).page, 2);
    assert.equal(JSON.parse(h.data.get(RESUME_KEY)).key, '/b');
});

for (const outcome of [false, 'true', 'reject']) {
    test(`a cross-alias ${outcome} guard retains the identical original dialog and settles the refusal`, async (t) => {
        const h = host(t);
        const a = shared.openExpandedModal({ url: '/a', resume: true });
        await tick();
        const callA = await mount(h);
        const answer = guard(callA);
        const saved = h.data.get(RESUME_KEY);
        const b = explorer.openExpandedModal({ url: '/b', resume: true });
        await tick();
        if (outcome === 'reject') answer.reject(new Error('guard failed'));
        else answer.resolve(outcome);
        assert.equal(await settled(b.opened), null);
        await settled(b);
        assert.equal(b.isClosed(), true);
        assert.equal(callA.signal.aborted, false);
        assert.equal(callA.dialog.removals, 0);
        assert.equal(h.calls.length, 1);
        assert.equal(h.data.get(RESUME_KEY), saved);
        assert.equal(explorer.openExpandedModal({ url: '/a' }), a);
    });
}

test('self-close during cross-alias preparation admits the waiting panel', async (t) => {
    const h = host(t);
    const a = shared.openExpandedModal({ url: '/a' });
    await tick();
    const callA = await mount(h);
    const answer = guard(callA);
    const b = explorer.openExpandedModal({ url: '/b' });
    await tick();
    callA.dialog.close();
    await settled(a);
    answer.resolve(true);
    await tick();
    assert.equal(h.calls.length, 2);
    const callB = await mount(h);
    assert.equal(await b.opened, callB.dialog);
});

for (const failure of ['preload throw', 'render reject', 'render throw', 'render null']) {
    test(`a ${failure} settles both promises and allows a fresh same-key retry through the other alias`, async (t) => {
        const h = host(t);
        const showModal = h.ui.showModal;
        if (failure === 'preload throw') h.ui.ensureExpandedModalReady = () => { throw new Error('preload failed'); };
        if (failure === 'render throw') h.ui.showModal = () => { throw new Error('render failed'); };
        const failed = shared.openExpandedModal({ url: '/retry', resume: true });
        const same = explorer.openExpandedModal({ url: '/retry' });
        assert.equal(same, failed);
        await tick();
        if (failure === 'render reject') h.calls[0].reject(new Error('render failed'));
        if (failure === 'render null') h.calls[0].resolve(null);
        assert.equal(await settled(failed.opened), null);
        await settled(failed);
        assert.equal(failed.isClosed(), true);
        assert.equal(h.data.has(RESUME_KEY), false);
        h.ui.ensureExpandedModalReady = undefined;
        h.ui.showModal = showModal;
        const retry = explorer.openExpandedModal({ url: '/retry' });
        assert.notEqual(retry, failed);
        await tick();
        const call = await mount(h);
        assert.equal(await retry.opened, call.dialog);
    });
}

test('a cancelled late render disposes only its own dialog and cannot clear a newer same-key owner', async (t) => {
    const h = host(t);
    const first = shared.openExpandedModal({ url: '/same', resume: true });
    await tick();
    const late = h.calls[0];
    const middle = explorer.openExpandedModal({ url: '/middle' });
    await settled(first);
    assert.equal(await first.opened, null);
    const latest = shared.openExpandedModal({ url: '/same', resume: true });
    await settled(middle);
    await tick();
    const current = await mount(h);
    const saved = h.data.get(RESUME_KEY);
    late.resolve(late.dialog);
    h.calls[1].reject(new Error('obsolete render failed'));
    await tick();
    assert.ok(late.dialog.removals > 0);
    assert.equal(current.dialog.removals, 0);
    assert.equal(current.signal.aborted, false);
    assert.equal(h.data.get(RESUME_KEY), saved);
    assert.equal(explorer.openExpandedModal({ url: '/same' }), latest);
});

test('independent Documents isolate ownership, late close cleanup, resume storage and unload listeners', async (t) => {
    const a = host(t);
    const first = shared.openExpandedModal({ url: '/same', resume: true });
    await tick();
    const callA = await mount(a);
    const b = host(t);
    const second = explorer.openExpandedModal({ url: '/same', resume: true });
    assert.notEqual(first, second);
    await tick();
    const callB = await mount(b);
    a.win.dispatchEvent(new Event('pagehide'));
    callA.dialog.close();
    await settled(first);
    assert.equal(a.data.has(RESUME_KEY), true, 'the unloading document retains its own resume record');
    assert.equal(b.data.has(RESUME_KEY), true, 'old callbacks cannot clear the current document resume record');
    assert.equal(callB.signal.aborted, false);
    assert.equal(shared.openExpandedModal({ url: '/same' }), second);
    assert.deepEqual(a.listeners, ['pagehide', 'beforeunload']);
    assert.deepEqual(b.listeners, ['pagehide', 'beforeunload']);
    callB.dialog.close();
    await settled(second);
    assert.equal(b.data.has(RESUME_KEY), false, 'unload state stays with its own document');
});

test('a delayed guard retains its Document while another Document opens its own panel', async (t) => {
    const a = host(t);
    shared.openExpandedModal({ url: '/a' });
    await tick();
    const answer = guard(await mount(a));
    const pending = explorer.openExpandedModal({ url: '/waiting' });
    await tick();
    const b = host(t);
    const independent = shared.openExpandedModal({ url: '/independent' });
    await tick();
    const callB = await mount(b);
    answer.resolve(true);
    await tick();
    assert.equal(a.calls.length, 2, 'the old document renderer owns the delayed launch');
    const callA = await mount(a);
    assert.equal(await pending.opened, callA.dialog);
    assert.equal(explorer.openExpandedModal({ url: '/independent' }), independent);
    assert.equal(callB.dialog.removals, 0);
    a.activate();
    assert.equal(shared.openExpandedModal({ url: '/waiting' }), pending);
});
