import test from 'node:test';
import assert from 'node:assert/strict';

import { openExpandedModal, restoreExpandedModal } from '../../shared/ui/expanded-modal.js';
import { createExpandedModalPreload } from '../../shared/ui/expanded-modal-preload.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function installHost({ ready, storage = new Map() }) {
    const shown = [];
    const previous = { assistOS: globalThis.assistOS, sessionStorage: globalThis.sessionStorage };
    globalThis.assistOS = {
        UI: {
            ensureExpandedModalReady: typeof ready === 'function' ? ready : (ready ? () => ready : undefined),
            showModal(name, payload, expectResult, { signal }) {
                shown.push({ name, payload, signal });
                return new Promise(() => {});
            }
        }
    };
    globalThis.sessionStorage = {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key)
    };
    return {
        shown,
        restore() {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
            }
        }
    };
}

test('T4: openExpandedModal does not open its dialog before the preload promise resolves', async () => {
    const ready = deferred();
    const host = installHost({ ready: ready.promise });
    try {
        void openExpandedModal({ mode: 'iframe', url: '/panel-a.html', title: 'A' });
        await tick();
        assert.equal(host.shown.length, 0, 'the shell is still loading');

        ready.resolve();
        await tick();
        assert.equal(host.shown.length, 1);
        assert.equal(host.shown[0].name, 'expanded-modal');
        assert.equal(host.shown[0].payload.url, '/panel-a.html');
    } finally {
        host.restore();
    }
});

test('T4: restoreExpandedModal waits for the preload promise as well', async () => {
    const ready = deferred();
    const storage = new Map([['explorer.expandedModal.resume', JSON.stringify({
        key: '/panel-b.html',
        resume: true,
        mode: 'iframe',
        url: '/panel-b.html',
        title: 'B'
    })]]);
    const host = installHost({ ready: ready.promise, storage });
    try {
        void restoreExpandedModal();
        await tick();
        assert.equal(host.shown.length, 0);

        ready.resolve();
        await tick();
        assert.equal(host.shown.length, 1);
        assert.equal(host.shown[0].payload.url, '/panel-b.html');
    } finally {
        host.restore();
    }
});

test('T4: a failed preload opens no panel and settles the launch', async () => {
    const ready = deferred();
    ready.promise.catch(() => {});
    const host = installHost({ ready: ready.promise });
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));
    try {
        const closed = openExpandedModal({ mode: 'iframe', url: '/panel-c.html', title: 'C' });
        ready.reject(new Error('expanded modal assets unavailable'));
        await closed;

        assert.equal(host.shown.length, 0);
        assert.ok(errors.some((line) => line.includes('Failed to open panel')), errors.join('\n'));
    } finally {
        console.error = originalError;
        host.restore();
    }
});

test('T4: without a preload promise the panel opens as before', async () => {
    const host = installHost({ ready: undefined });
    try {
        void openExpandedModal({ mode: 'iframe', url: '/panel-d.html', title: 'D' });
        await tick();
        assert.equal(host.shown.length, 1);
    } finally {
        host.restore();
    }
});

test('F2: a failed preload is not sticky; the next launch loads the shell again and opens the panel', async () => {
    const loads = [];
    let failFirst = true;
    const webSkel = {
        configs: { components: [{ name: 'expanded-modal', type: 'modals' }] },
        ResourceManager: {
            components: {},
            async loadComponent(config) {
                loads.push(config.name);
                if (failFirst) {
                    failFirst = false;
                    // WebSkel keeps the rejected load in its registry.
                    this.components['expanded-modal'] = { isPromiseFulfilled: false };
                    throw new Error('shell assets unavailable');
                }
                this.components['expanded-modal'] = { isPromiseFulfilled: true };
                return {};
            }
        }
    };
    const ensure = createExpandedModalPreload(webSkel);
    const bootPreload = ensure();
    bootPreload.catch(() => {});
    const host = installHost({ ready: ensure });
    const originalError = console.error;
    console.error = () => {};
    try {
        await assert.rejects(bootPreload, /shell assets unavailable/);
        assert.equal(webSkel.ResourceManager.components['expanded-modal'], undefined, 'the failed registry entry was cleared');

        // The first launch after the failure retries once; an overlapping launch shares that attempt.
        void openExpandedModal({ mode: 'iframe', url: '/panel-e.html', title: 'E' });
        void openExpandedModal({ mode: 'iframe', url: '/panel-f.html', title: 'F' });
        await tick();
        await tick();
        assert.equal(loads.length, 2, 'one boot attempt and one shared retry');
        assert.equal(host.shown.length >= 1, true, 'the panel opens after the retry succeeds');
        assert.equal(host.shown.at(-1).name, 'expanded-modal');

        void openExpandedModal({ mode: 'iframe', url: '/panel-g.html', title: 'G' });
        await tick();
        assert.equal(loads.length, 2, 'a success is cached');
    } finally {
        console.error = originalError;
        host.restore();
    }
});

test('F2: a retry that also fails does not poison later attempts', async () => {
    let calls = 0;
    const webSkel = {
        configs: { components: [{ name: 'expanded-modal' }] },
        ResourceManager: { components: {}, async loadComponent() { calls += 1; throw new Error(`failure ${calls}`); } }
    };
    const ensure = createExpandedModalPreload(webSkel);
    await assert.rejects(ensure(), /failure 1/);
    await assert.rejects(ensure(), /failure 2/);
    assert.equal(calls, 2);
});
