import test from 'node:test';
import assert from 'node:assert/strict';

import { openExpandedModal, restoreExpandedModal } from '../../shared/ui/expanded-modal.js';

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
            expandedModalReady: ready,
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
