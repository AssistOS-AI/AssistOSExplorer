import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await fs.readFile(new URL('../../shared/ui/expanded-modal.js', import.meta.url), 'utf8'))
    .replace('export function openExpandedModal', 'function openExpandedModal')
    .replace('export function restoreExpandedModal', 'function restoreExpandedModal');
const tick = () => new Promise(resolve => setImmediate(resolve));
const RESUME_KEY = 'explorer.expandedModal.resume';

function createHost(storage = new Map()) {
    const calls = [];
    const updates = [];
    const context = vm.createContext({
        AbortController,
        console,
        sessionStorage: {
            getItem: (key) => (storage.has(key) ? storage.get(key) : null),
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: (key) => storage.delete(key)
        },
        assistOS: { UI: {
            showModal(name, payload, expectResult, { signal }) {
                let finish;
                const promise = new Promise(resolve => { finish = resolve; });
                const dialog = new EventTarget();
                dialog.removed = false;
                dialog.close = () => dialog.dispatchEvent(new Event('close'));
                dialog.remove = () => { dialog.removed = true; };
                dialog.querySelector = () => ({ webSkelPresenter: { updateDescriptor: d => updates.push(d) } });
                calls.push({ name, payload, expectResult, signal, dialog, finish: () => finish(signal.aborted ? null : dialog) });
                return promise;
            }
        } }
    });
    vm.runInContext(`${source}\nthis.open = openExpandedModal; this.restore = restoreExpandedModal;`, context);
    return { open: context.open, restore: context.restore, calls, updates, storage };
}

function host() {
    return createHost();
}

test('a resumable panel survives a reload but a non-resumable panel does not', async () => {
    const storage = new Map();
    const first = createHost(storage);
    first.open({ mode: 'iframe', url: '/webmeetAgent/roomLoader.html', title: 'WebMeet', resume: true });
    await tick();
    assert.ok(storage.get(RESUME_KEY), 'resumable descriptors are persisted');

    const second = createHost(storage);
    second.restore();
    await tick();
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].payload.url, '/webmeetAgent/roomLoader.html');

    const nonResumable = createHost(new Map());
    nonResumable.open({ mode: 'iframe', url: '/other/panel.html', title: 'Other' });
    await tick();
    assert.equal(nonResumable.storage.get(RESUME_KEY), undefined);
});

test('concurrent identical launches share a dialog and the close promise', async () => {
    const h = host();
    const first = h.open({ component: 'git-panel', props: { openConflictHelper: false } });
    const second = h.open({ component: 'git-panel', props: { openConflictHelper: true, selectedRepoPath: 'repos/a' } });
    assert.equal(first, second);
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].expectResult, false);
    assert.equal(JSON.parse(h.calls[0].payload.props).openConflictHelper, false);
    h.calls[0].finish();
    await tick();
    assert.equal(h.updates.at(-1).props.selectedRepoPath, 'repos/a');
    let closed = false;
    first.then(() => { closed = true; });
    await tick();
    assert.equal(closed, false);
    h.calls[0].dialog.close();
    await first;
    assert.equal(h.calls[0].dialog.removed, true);
});

test('reopening visible content forwards new properties without recreating it', async () => {
    const h = host();
    const first = h.open({ component: 'git-panel', props: { repoPath: 'repos' } });
    await tick(); h.calls[0].finish(); await tick();
    assert.equal(h.open({ component: 'git-panel', props: { openConflictHelper: true } }), first);
    assert.equal(h.calls.length, 1);
    assert.equal(h.updates.at(-1).props.repoPath, 'repos');
    assert.equal(h.updates.at(-1).props.openConflictHelper, true);
    h.calls[0].dialog.close(); await first;
});

test('different content cancels a pending launch and resolves its waiter', async () => {
    const h = host();
    const first = h.open({ component: 'git-panel' });
    await tick();
    const next = h.open({ component: 'help-modal' });
    await first; await tick();
    assert.equal(h.calls[0].signal.aborted, true);
    h.calls[0].finish(); h.calls[1].finish(); await tick();
    assert.equal(h.updates.length, 1);
    assert.equal(h.updates[0].component, 'help-modal');
    h.calls[1].dialog.close(); await next;
});

test('different content disposes a visible panel', async () => {
    const h = host();
    const first = h.open({ component: 'git-panel' });
    await tick(); h.calls[0].finish(); await tick();
    const next = h.open({ component: 'help-modal' });
    await first; await tick();
    assert.equal(h.calls[0].dialog.removed, true);
    h.calls[1].finish(); await tick(); h.calls[1].dialog.close(); await next;
});

test('camelCase attributes and typed props survive payload encoding', async () => {
    const h = host();
    const closed = h.open({ iframeUrl: '/meet', agentRef: 'repo/meet', fullscreen: false, props: { enabled: false, count: 2 } });
    await tick();
    assert.equal(h.calls[0].payload['iframe-url'], '/meet');
    assert.equal(h.calls[0].payload['agent-ref'], 'repo/meet');
    assert.equal(h.calls[0].payload.fullscreen, false);
    assert.deepEqual(JSON.parse(h.calls[0].payload.props), { enabled: false, count: 2 });
    h.calls[0].finish(); await tick(); h.calls[0].dialog.close(); await closed;
});

// ---- Guarded replacement: a mounted panel whose content guards its closing stays until it approves ----

function guardedHost(storage = new Map()) {
    const h = createHost(storage);
    const guard = { active: true, reasons: [], answers: [] };
    // The mounted dialog's presenter guards its closing; the test resolves each prepareClose('replace') answer.
    return {
        ...h,
        guard,
        mountGuarded(index) {
            const dialog = h.calls[index].dialog;
            dialog.querySelector = () => ({ webSkelPresenter: {
                updateDescriptor: d => h.updates.push(d),
                hasCloseGuard: () => guard.active,
                prepareClose: (reason) => {
                    guard.reasons.push(reason);
                    return new Promise((resolve, reject) => { guard.answers.push({ resolve, reject }); });
                },
            } });
        },
    };
}

test('a guarded panel stays while it prepares; a refusal cancels the incoming request without touching the active panel or its resume record', async () => {
    const h = guardedHost();
    const first = h.open({ mode: 'iframe', url: '/live.html', title: 'Live', resume: true });
    await tick(); h.mountGuarded(0); h.calls[0].finish(); await tick();
    const resumeBefore = h.storage.get(RESUME_KEY);
    const next = h.open({ mode: 'iframe', url: '/other.html', title: 'Other', resume: true });
    assert.equal(typeof next.then, 'function');
    assert.equal(typeof next.isClosed, 'function', 'the decorated promise is returned synchronously');
    assert.equal(next.isClosed(), false);
    await tick();
    assert.deepEqual(h.guard.reasons, ['replace']);
    assert.equal(h.calls.length, 1, 'nothing new is shown while the active panel decides');
    assert.equal(h.calls[0].dialog.removed, false);
    assert.equal(h.storage.get(RESUME_KEY), resumeBefore, 'the resume record still names the active panel');
    h.guard.answers[0].resolve(false);
    assert.equal(await next.opened, null);
    await next;
    assert.equal(next.isClosed(), true);
    assert.equal(h.calls[0].dialog.removed, false);
    assert.equal(h.calls[0].signal.aborted, false);
    assert.equal(h.storage.get(RESUME_KEY), resumeBefore);
    // The active panel is still the active one: reopening it returns its own promise.
    assert.equal(h.open({ mode: 'iframe', url: '/live.html', title: 'Live' }), first);
});

test('an approved replacement disposes the guarded panel and then shows the new one', async () => {
    const h = guardedHost();
    const first = h.open({ mode: 'iframe', url: '/live.html', title: 'Live' });
    await tick(); h.mountGuarded(0); h.calls[0].finish(); await tick();
    const next = h.open({ component: 'help-modal' });
    await tick();
    h.guard.answers[0].resolve(true);
    await first;
    await tick();
    assert.equal(h.calls[0].dialog.removed, true);
    assert.equal(h.calls.length, 2);
    h.calls[1].finish();
    assert.notEqual(await next.opened, null);
    h.calls[1].dialog.close(); await next;
});

test('A to B to C: B owns the transition, C is cancelled at once, a repeated B shares its promise, and a rejecting guard refuses', async () => {
    const h = guardedHost();
    h.open({ mode: 'iframe', url: '/live.html', title: 'Live' });
    await tick(); h.mountGuarded(0); h.calls[0].finish(); await tick();
    const b = h.open({ component: 'help-modal', props: { page: 1 } });
    const c = h.open({ component: 'git-panel' });
    assert.equal(await c.opened, null, 'the competing request settles opened with null');
    await c;
    assert.equal(c.isClosed(), true);
    const bAgain = h.open({ component: 'help-modal', props: { page: 2 } });
    assert.equal(bAgain, b, 'an identical incoming request shares the pending promise');
    await tick();
    assert.equal(h.guard.reasons.length, 1, 'one preparation');
    h.guard.answers[0].resolve(true);
    await tick(); await tick();
    assert.equal(h.calls.length, 2, 'B is shown once and C never');
    assert.equal(h.calls[1].payload.component, 'help-modal');
    assert.equal(JSON.parse(h.calls[1].payload.props).page, 2, 'the coalesced descriptor is used');

    const r = guardedHost();
    r.open({ mode: 'iframe', url: '/live.html', title: 'Live' });
    await tick(); r.mountGuarded(0); r.calls[0].finish(); await tick();
    const refused = r.open({ component: 'help-modal' });
    await tick();
    r.guard.answers[0].reject(new Error('page failed'));
    assert.equal(await refused.opened, null);
    assert.equal(r.calls[0].dialog.removed, false);
});

test('when the guarded panel closes itself during the preparation, the waiting panel opens', async () => {
    const h = guardedHost();
    h.open({ mode: 'iframe', url: '/live.html', title: 'Live' });
    await tick(); h.mountGuarded(0); h.calls[0].finish(); await tick();
    const next = h.open({ component: 'help-modal' });
    await tick();
    // The person chose Keep running from the panel's own X: the shared preparation approves and the panel closes.
    h.calls[0].dialog.close();
    h.guard.answers[0].resolve(true);
    await tick(); await tick();
    assert.equal(h.calls.length, 2);
    h.calls[1].finish();
    assert.notEqual(await next.opened, null);

    const unguarded = guardedHost();
    unguarded.guard.active = false;
    unguarded.open({ mode: 'iframe', url: '/live.html', title: 'Live' });
    await tick(); unguarded.mountGuarded(0); unguarded.calls[0].finish(); await tick();
    const plain = unguarded.open({ component: 'help-modal' });
    assert.equal(unguarded.calls[0].dialog.removed, true, 'an unguarded mounted panel is replaced at once, as before');
    assert.deepEqual(unguarded.guard.reasons, []);
    await tick(); unguarded.calls[1].finish(); await tick(); unguarded.calls[1].dialog.close(); await plain;
});
