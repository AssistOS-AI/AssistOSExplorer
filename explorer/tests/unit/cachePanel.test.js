import assert from 'node:assert/strict';
import test from 'node:test';
import { CachePanel } from '../../web-components/components/cache-panel/cache-panel.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { resolve, reject, promise };
}

function snapshot() {
    return {
        applications: [{
            agent: 'org/site', enabled: true, pageSeconds: 300, held: null,
            routes: [{ path: '/news', cache: 'page' }, { path: '/v1', cache: 'immutable' }],
            hosts: ['first.example', 'second.example'],
        }],
        hosts: ['first.example', 'second.example'].map((host) => ({ host, purgeConfigured: true, lastPurge: null })),
    };
}

function panel(initial, api) {
    const content = {};
    const element = Object.assign(new EventTarget(), {
        querySelector: () => content,
        contains: () => true,
        cacheSnapshot: initial,
    });
    const presenter = new CachePanel(element, () => {}, { api });
    return { presenter, element, content };
}

test('loads, renders marked paths and minutes, and escapes Router-supplied values', async () => {
    const data = snapshot();
    const app = data.applications[0];
    app.held = { since: '2026-11-23T01:00:00Z', by: '<img src=x>' };
    app.agent = 'org/" onclick="bad';
    app.routes.push({ path: '<script>', cache: 'page' });
    data.hosts[1].purgeConfigured = false;
    const pending = deferred();
    const { presenter, content } = panel(null, { read: () => pending.promise });
    const loading = presenter.afterRender();
    assert.match(content.innerHTML, /Loading cache settings/);
    pending.resolve(data);
    await loading;
    assert.match(content.innerHTML, /Held since 2026-11-23T01:00:00Z by &lt;img/);
    assert.match(content.innerHTML, /data-cache-toggle="org\/&quot; onclick=&quot;bad" checked disabled/);
    assert.match(content.innerHTML, /<option value="5" selected>5 minutes/);
    assert.match(content.innerHTML, /\/news<\/code> · page/);
    assert.match(content.innerHTML, /\/v1<\/code> · immutable/);
    assert.match(content.innerHTML, /&lt;script&gt;/);
    assert.match(content.innerHTML, /cannot see Cloudflare’s rules or cached objects/);
    assert.match(content.innerHTML, /data-purge-host="second.example" disabled/);
    assert.doesNotMatch(content.innerHTML, /<script>|<img| onclick="bad/);
    await presenter.change(app.agent, { enabled: false });
    assert.equal(presenter.error, '');
});

test('freshness changes send complete settings and reject unsupported minute choices', async () => {
    const data = snapshot();
    const writes = [];
    const api = {
        setApplication: async (fields) => {
            writes.push(fields);
            Object.assign(data.applications[0], fields);
            return { application: data.applications[0], purges: [] };
        },
        read: async () => structuredClone(data),
    };
    const { presenter, element, content } = panel(structuredClone(data), api);
    await presenter.afterRender();
    for (const value of ['1', '2', '5', '0', '9']) {
        const event = new Event('change');
        Object.defineProperty(event, 'target', { value: { dataset: { cacheMinutes: 'org/site' }, value } });
        element.dispatchEvent(event);
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(writes, [60, 120, 300].map((pageSeconds) => ({ agent: 'org/site', enabled: true, pageSeconds })));
    assert.match(content.innerHTML, /value="5" selected/);
});

test('switch-off shows each result before the follow-up read supplies the last clear time and actor', async () => {
    const data = snapshot();
    data.applications[0].hosts.push('third.example');
    data.hosts.push({ host: 'third.example', purgeConfigured: false, lastPurge: null });
    const app = { ...data.applications[0], enabled: false };
    const purges = [
        { host: 'first.example', outcome: 'accepted' },
        { host: 'second.example', outcome: 'failed' },
        { host: 'third.example', outcome: 'unconfigured' },
    ];
    const refresh = deferred();
    const api = {
        setApplication: async (fields) => {
            assert.deepEqual(fields, { agent: app.agent, enabled: false, pageSeconds: 300 });
            return { application: app, purges };
        },
        read: () => refresh.promise,
    };
    const { presenter, content } = panel(data, api);
    await presenter.afterRender();
    const action = presenter.change(app.agent, { enabled: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(content.innerHTML, /first.example · accepted/);
    assert.match(content.innerHTML, /second.example · failed/);
    assert.match(content.innerHTML, /third.example · unconfigured/);
    assert.match(content.innerHTML, /Response received at \d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(content.innerHTML, /data-cache-toggle="org\/site" checked|Last recorded clear:/);
    refresh.resolve({
        applications: [app],
        hosts: data.hosts.map((host, i) => ({
            ...host, lastPurge: { ...purges[i], at: '2026-11-23T10:00:00Z', by: 'admin' },
        })),
    });
    await action;
    assert.match(content.innerHTML, /Last recorded clear: failed at 2026-11-23T10:00:00Z by admin/);
    assert.doesNotMatch(content.innerHTML, /data-cache-toggle="org\/site" checked/);
});

test('one click submits only one purge while busy, and refresh failure preserves the acknowledged result', async () => {
    const data = snapshot();
    const pending = deferred();
    const writes = [];
    let unavailable = true;
    const { presenter, element, content } = panel(data, {
        purgeHost: (body) => { writes.push(body); return pending.promise; },
        read: async () => {
            if (unavailable) throw new Error('transport');
            return data;
        },
    });
    await presenter.afterRender();
    for (const host of ['first.example', 'second.example']) {
        const button = { dataset: { purgeHost: host }, hasAttribute: () => false };
        const click = new Event('click');
        Object.defineProperty(click, 'target', { value: { closest: () => button } });
        element.dispatchEvent(click);
    }
    assert.deepEqual(writes, [{ host: 'first.example' }]);
    pending.resolve({ purge: { host: 'first.example', outcome: 'cooldown', retryAfterSeconds: 12 } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(content.innerHTML, /first.example · cooldown \(retry after 12 seconds\)/);
    assert.match(content.innerHTML, /Response received at \d{4}-\d{2}-\d{2}T/);
    assert.match(content.innerHTML, /Could not refresh/);
    assert.match(content.innerHTML, /data-cache-toggle="org\/site" checked disabled/);
    unavailable = false;
    await presenter.refresh();
    assert.doesNotMatch(content.innerHTML, /retry after|Could not refresh/);
});

test('denial drops protected state and bubbles to Settings; unload suppresses late events', async () => {
    for (const unload of [false, true]) {
        const pending = deferred();
        const { presenter, element, content } = panel(snapshot(), { purgeHost: () => pending.promise });
        const denials = [];
        element.addEventListener('cache-access-denied', (event) => denials.push(event.bubbles));
        await presenter.afterRender();
        const action = presenter.purge('first.example');
        if (unload) presenter.afterUnload();
        pending.reject(Object.assign(new Error('forbidden'), { status: 403 }));
        await action;
        assert.deepEqual(denials, unload ? [] : [true]);
        if (!unload) {
            assert.equal(presenter.snapshot, null);
            assert.equal(content.textContent, 'Administrator access is required.');
        }
    }
});

test('returning to the tab reads again and renders an empty application list', async () => {
    const { presenter, element, content } = panel(snapshot(), { read: async () => ({ applications: [], hosts: [] }) });
    await presenter.afterRender();
    element.dispatchEvent(new CustomEvent('cache-active', { detail: false }));
    element.dispatchEvent(new CustomEvent('cache-active', { detail: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(content.innerHTML, /No applications have cacheable paths/);
});

test('closing Settings before WebSkel finishes loading the presenter prevents its first read', async () => {
    let reads = 0;
    const { presenter, element } = panel(null, { read: async () => { reads++; return snapshot(); } });
    element.isConnected = false;
    await presenter.afterRender();
    assert.equal(reads, 0);
});
