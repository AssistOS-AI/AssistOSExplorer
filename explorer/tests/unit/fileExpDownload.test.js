import test from 'node:test';
import assert from 'node:assert/strict';
import { attachDownloadActions, buildDownloadUrl, isDownloadablePath } from '../../web-components/pages/file-exp/file-exp-download.js';

function presenter() {
    const cleanup = [];
    const messages = [];
    const host = {
        state: { selectedPath: '/docs/selected.md', path: '/docs' },
        registerCleanup(fn) { cleanup.push(fn); },
        closeActionMenu() {},
        showStatus(message, error) { messages.push({ message, error }); }
    };
    attachDownloadActions(host);
    return { host, messages, dispose: () => cleanup.forEach(fn => fn()) };
}

const entry = (path = '/docs/notes.md', type = 'file') => ({ dataset: { entryPath: path, type } });
const ready = { ok: true, headers: { get: () => 'attachment; filename="notes.md"' } };

test('download URL encodes each path segment and refuses unsafe/private paths', () => {
    assert.equal(buildDownloadUrl('/docs/fișier #1 & %.md'), '/workspace-files/docs/fi%C8%99ier%20%231%20%26%20%25.md?download=1');
    assert.ok(isDownloadablePath('/.ploinky/repos/project/file.txt'));
    for (const path of ['/', '/docs/../private', '/.data/secret', '/.ploinky/config.json', '/nested/.ploinky/config.json', '/Confidential/file', '/docs/file.secrets', '/docs/a\\b', '/docs/\0bad']) {
        assert.equal(isDownloadablePath(path), false, path);
        assert.throws(() => buildDownloadUrl(path));
    }
});

test('file/folder downloads use HEAD preflight and native anchor without changing Explorer state', async () => {
    const originalFetch = globalThis.fetch;
    const originalDocument = globalThis.document;
    const requests = [];
    const anchors = [];
    globalThis.fetch = async (url, options) => { requests.push({ url, options }); return ready; };
    globalThis.document = {
        body: { appendChild(anchor) { anchor.appended = true; } },
        createElement(tag) {
            assert.equal(tag, 'a');
            const anchor = { click() { this.clicked = true; }, remove() { this.removed = true; } };
            anchors.push(anchor);
            return anchor;
        }
    };
    try {
        const { host, messages } = presenter();
        const state = JSON.stringify(host.state);
        assert.equal(await host.downloadEntry(entry()), true);
        assert.equal(await host.downloadEntry(entry('/docs/project', 'directory')), true);
        assert.equal(JSON.stringify(host.state), state);
        assert.deepEqual(anchors.map(anchor => anchor.download), ['notes.md', 'project.zip']);
        for (const anchor of anchors) assert.ok(anchor.appended && anchor.clicked && anchor.removed && anchor.hidden);
        for (const request of requests) {
            assert.equal(request.options.method, 'HEAD');
            assert.equal(request.options.credentials, 'same-origin');
            assert.equal(request.options.cache, 'no-store');
            assert.match(request.url, /^\/workspace-files\//);
        }
        assert.ok(messages.some(row => row.message.includes('browser downloads')));
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.document = originalDocument;
    }
});

test('denied/missing/error/older-server responses show an error without triggering navigation', async () => {
    const originalFetch = globalThis.fetch;
    try {
        for (const response of [{ ok: false, status: 403 }, { ok: false, status: 404 }, { ok: false, status: 500 }, { ok: true, headers: { get: () => 'inline' } }]) {
            globalThis.fetch = async () => response;
            const { host, messages } = presenter();
            assert.equal(await host.downloadEntry(entry()), false);
            assert.equal(messages.at(-1).error, true);
        }
        globalThis.fetch = async () => { throw new Error('Network unavailable'); };
        const { host, messages } = presenter();
        assert.equal(await host.downloadEntry(entry()), false);
        assert.equal(messages.at(-1).message, 'Network unavailable');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('duplicate requests are suppressed and unload cancels preflight without a late click', async () => {
    const originalFetch = globalThis.fetch;
    let finish;
    let signal;
    let requests = 0;
    globalThis.fetch = (url, options) => {
        requests += 1;
        signal = options.signal;
        return new Promise(resolve => { finish = resolve; });
    };
    try {
        const { host, messages, dispose } = presenter();
        const first = host.downloadEntry(entry());
        assert.equal(await host.downloadEntry(entry()), false);
        assert.equal(requests, 1);
        dispose();
        assert.equal(signal.aborted, true);
        finish(ready);
        assert.equal(await first, false);
        assert.equal(await host.downloadEntry(entry()), false);
        assert.equal(messages.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('context menus expose Download for ordinary files and folders but not protected providers', async () => {
    const originalWindow = globalThis.window;
    globalThis.window = { assistOS: {}, addEventListener() {}, removeEventListener() {} };
    try {
        const { getBuiltInContextMenuItems } = await import('../../web-components/pages/file-exp/file-exp-menu-contributions.js');
        const host = { state: {}, normalizePath: value => value };
        for (const type of ['file', 'directory']) {
            const download = getBuiltInContextMenuItems(host, { path: '/docs/item', type }).find(item => item.action === 'downloadEntry');
            assert.equal(download.label, 'Download');
            assert.equal(download.entryType, type);
        }
        for (const target of [{ path: '/Confidential/file', type: 'file', virtualProvider: 'dpu' }, { path: '/.data/file', type: 'file' }, { path: '/docs/file.secrets', type: 'file' }]) {
            assert.ok(!getBuiltInContextMenuItems(host, target).some(item => item.action === 'downloadEntry'));
        }
    } finally {
        globalThis.window = originalWindow;
    }
});
