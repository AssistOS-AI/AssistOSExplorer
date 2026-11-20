import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const fail of [false, true]) {
    test(`dashboard keeps the loader through active-tab data and render (${fail ? 'failure' : 'success'})`, async t => {
        const keys = ['window', 'document', 'fetch', 'requestAnimationFrame'];
        const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
        t.after(() => previous.forEach(([key, descriptor]) => {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }));
        let loading = 'true', finish;
        const response = new Promise(resolve => { finish = resolve; });
        const frames = [], status = { hidden: true, textContent: '' };
        globalThis.window = { location: { hash: '#blacklist', pathname: '/management/' } };
        globalThis.document = { documentElement: {
            getAttribute: () => loading,
            setAttribute: (name, value) => { assert.equal(name, 'data-app-loading'); loading = value; },
        }, querySelector: () => status };
        globalThis.requestAnimationFrame = callback => frames.push(callback);
        let requests = 0;
        globalThis.fetch = async () => {
            requests++;
            await response;
            if (fail) throw new Error('Unavailable');
            return { status: 200, json: async () => [] };
        };
        await import(`../../dashboard/js/app.mjs?startup=${fail}`);
        await window.providersPage('providers').init();
        assert.equal(requests, 0);
        assert.equal(frames.length, 0);
        const active = window.blacklistPage('blacklist');
        let rendered = false;
        active.$nextTick = async () => { rendered = true; };
        const pending = active.init();
        assert.equal(loading, 'true');
        assert.equal(requests, 1);
        finish();
        await pending;
        assert.equal(rendered, true);
        assert.equal(loading, 'true');
        assert.equal(status.hidden, !fail);
        frames.shift()();
        assert.equal(loading, 'false');
    });
}

test('dashboard HTML advertises pending startup before any scripts execute', async () => {
    const html = await readFile(new URL('../../dashboard/index.html', import.meta.url), 'utf8');
    assert.match(html, /<html[^>]*data-app-loading="true"/);
    assert.match(html, /id="dashboardStartupError" role="alert" hidden/);
});
