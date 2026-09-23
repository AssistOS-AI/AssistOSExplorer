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
