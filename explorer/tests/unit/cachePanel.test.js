import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CachePanel, renderCachePanel } from '../../web-components/components/cache-panel/cache-panel.js';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { resolve, reject, promise };
}

const PAGE = 'max-age=300, stale-if-error=900';
const IMMUTABLE = 'max-age=31536000';

function route(path, extra = {}) {
    return {
        path, manifest: null, neverBy: null, publicProtocol: false, setting: null, stale: false,
        effective: null, source: null, cdnHeader: 'no-store', choices: [], checkable: true, ...extra,
    };
}

function publicRoutes() {
    return [
        route('/news', { manifest: 'page', effective: 'page', source: 'manifest', cdnHeader: PAGE, choices: ['off'] }),
        route('/v1/*', { manifest: 'immutable', effective: 'immutable', source: 'manifest', cdnHeader: IMMUTABLE, choices: ['off'], checkable: false }),
        route('/about', { choices: ['page'] }),
        route('/pricing', {
            manifest: 'page', source: 'off', choices: ['default'],
            setting: { setting: 'off', at: '2026-11-27T10:00:00Z', by: 'admin' },
        }),
        route('/shared', {
            effective: 'page', source: 'administrator', cdnHeader: PAGE, choices: ['default'],
            setting: { setting: 'page', at: '2026-11-27T11:00:00Z', by: 'admin' },
        }),
        route('/login/', { manifest: 'never', source: 'never', choices: [] }),
        route('/p/abc', { neverBy: '/p/*', source: 'never', choices: [] }),
        route('/old', {
            stale: true, choices: ['default'],
            setting: { setting: 'page', at: '2026-11-20T09:00:00Z', by: 'admin' },
        }),
        route('/api/submit', { publicProtocol: true, checkable: false }),
        route('/files/*', { checkable: false }),
    ];
}

function snapshot() {
    return {
        applications: [{
            agent: 'org/site', enabled: true, pageSeconds: 300, held: null, hosts: ['first.example', 'second.example'],
            routes: [{ path: '/news', cache: 'page' }, { path: '/v1/*', cache: 'immutable' }],
            adminChoices: true, publicRoutes: publicRoutes(),
        }, {
            agent: 'org/plain', enabled: false, pageSeconds: 60, held: null, hosts: ['first.example'],
            routes: [], adminChoices: false, publicRoutes: [route('/', { choices: [] })],
        }],
        hosts: ['first.example', 'second.example'].map((host) => ({ host, purgeConfigured: true, lastPurge: null })),
    };
}

function v1Snapshot() {
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

const unescape = (value) => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');

// Build the button a browser would hand to the click handler, from the markup the panel rendered.
function buttonFrom(html, matcher) {
    const tag = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]).find((candidate) => matcher.test(candidate));
    assert.ok(tag, `no button matching ${matcher}`);
    const dataset = {};
    for (const [, name, value] of tag.matchAll(/data-([a-z-]+)(?:="([^"]*)")?/g)) {
        dataset[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = unescape(value ?? '');
    }
    return { dataset, hasAttribute: (name) => new RegExp(`\\s${name}(\\s|=|>)`).test(tag) };
}

function click(element, button) {
    const event = new Event('click');
    Object.defineProperty(event, 'target', { value: { closest: () => button } });
    element.dispatchEvent(event);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Every route row the panel rendered for a path (a stale setting can share its path with a live row).
function rowsFor(html, path) {
    return html.split('<li class="cache-route').slice(1).map((chunk) => chunk.split('</li>')[0]).filter((chunk) => chunk.includes(`title="${path}"`));
}

function rowOf(html, path) {
    const rows = rowsFor(html, path);
    assert.equal(rows.length, 1, `exactly one row for ${path}`);
    return rows[0];
}

const actionsOf = (row) => [...row.matchAll(/data-cache-route-action="([a-z]+)"/g)].map((match) => match[1]);
const switchOf = (row) => row.match(/<button type="button" role="switch" aria-checked="(true|false)"[^>]*data-cache-route-action="([a-z]+)"/);

test('rows that cannot be changed are not rendered: never, covered by never, publicProtocol and no-choice rows', () => {
    const data = snapshot();
    data.applications[0].publicRoutes.push(
        // The Router would not send these combinations, but the panel must still hide them.
        route('/proto', { publicProtocol: true, choices: ['page'] }),
        route('/covered', { manifest: 'page', neverBy: '/p/*', choices: ['off'] }),
        route('/only-check', { checkable: true, choices: [] }),
        route('/never-choice', { manifest: 'never', source: 'never', choices: ['default'] }),
    );
    const html = renderCachePanel({ snapshot: data });
    for (const path of ['/login/', '/p/abc', '/api/submit', '/files/*', '/proto', '/covered', '/only-check', '/never-choice']) assert.deepEqual(rowsFor(html, path), [], `${path} is hidden`);
    for (const path of ['/news', '/v1/*', '/about', '/pricing', '/shared', '/old']) assert.equal(rowsFor(html, path).length, 1, `${path} is shown`);
    assert.doesNotMatch(html, /Locked|cache-locked|>Never</);
    assert.match(html, /<span>Routes<\/span><span class="status-badge">6<\/span>/);
});

test('an application with no visible rows says so in one muted line', () => {
    const html = renderCachePanel({ snapshot: snapshot() });
    const plain = html.split('<article').slice(1)[1];
    assert.match(plain, /<p class="cache-card-meta">No routes can be changed here\.<\/p>/);
    assert.doesNotMatch(plain, /cache-route/);
});

test('renders the page head, Clear cache card, one card per application, and escapes every Router value', async () => {
    const data = snapshot();
    const app = data.applications[0];
    const hostile = '<img src=x onerror=1>';
    app.agent = 'org/" onclick="bad';
    app.held = { since: '2026-11-23T01:00:00Z', by: hostile };
    app.hosts = [hostile];
    app.publicRoutes = [
        route('<script>', {
            manifest: 'page', effective: 'page', source: 'manifest', cdnHeader: hostile, choices: ['off'],
            setting: { setting: 'off', at: hostile, by: '<b>who</b>' },
        }),
        route('/old"><i>', { stale: true, choices: ['default'], setting: { setting: 'page', at: '<u>t</u>', by: '<s>a</s>' } }),
    ];
    data.hosts = [{ host: hostile, purgeConfigured: false, lastPurge: { outcome: hostile, at: '<u>t</u>', by: '<s>a</s>' } }];
    const { presenter, content } = panel(data, {
        checkRoute: async () => ({ check: { host: hostile, path: '<svg>', status: hostile, cdnHeader: '<p>x</p>', cacheControl: '"><b>' } }),
    });
    await presenter.afterRender();
    await presenter.routeAction('check', app.agent, '<script>');
    const html = content.innerHTML;
    assert.match(html, /Held since 2026-11-23T01:00:00Z by &lt;img src=x onerror=1&gt;/);
    assert.match(html, /data-cache-toggle="org\/&quot; onclick=&quot;bad" aria-label="Caching for org\/&quot; onclick=&quot;bad" disabled/);
    assert.match(html, /title="&lt;script&gt;"/);
    assert.match(html, /aria-label="Caching for &lt;script&gt;"/);
    assert.match(html, /title="Set by &lt;b&gt;who&lt;\/b&gt; at &lt;img/);
    assert.match(html, /title="Set by &lt;s&gt;a&lt;\/s&gt; at &lt;u&gt;t&lt;\/u&gt;"/);
    assert.match(html, /aria-label="Routes of org\/&quot; onclick=&quot;bad"/);
    assert.match(html, /Tested now:<\/strong> HTTP &lt;img[^]*&lt;svg&gt;/);
    assert.doesNotMatch(html, /<img|<script|<svg>|<b>|<i>|<u>|<s>|<p>x| onclick="/);
});

test('page head, Clear cache card and application cards follow the Cloudflare structure', () => {
    const html = renderCachePanel({ snapshot: snapshot() });
    assert.match(html, /^<div class="cache-head"><div class="cache-head-text"><h2 class="settings-section-title cache-title">Cache<\/h2><p class="settings-section-description">[^<]*cannot see Cloudflare’s rules or cached objects\.<\/p><\/div>\s*<div class="settings-card-actions"><button type="button" class="gray-button" data-cache-refresh>Refresh<\/button>/);
    const [clear, ...rest] = html.split('<article');
    assert.match(clear, /<section class="settings-card settings-card-static cache-card cache-clear" aria-label="Clear cache">/);
    assert.match(clear, /<h3 class="cache-card-title">Clear cache<\/h3>/);
    assert.match(clear, /Removes Cloudflare’s copies for a host, so the next visitor gets a fresh answer\. Cleared at most once every 15 seconds per host\./);
    assert.match(clear, /class="cache-help"[^>]*title="[^"]+"/);
    assert.deepEqual([...clear.matchAll(/<strong class="cache-host-name">([^<]+)</g)].map((match) => match[1]), ['first.example', 'second.example']);
    assert.deepEqual([...clear.matchAll(/data-purge-host="([^"]+)"[^>]*>Clear cache now</g)].map((match) => match[1]), ['first.example', 'second.example']);
    assert.match(clear, /status-badge success">Purge configured/);
    assert.match(clear, /No recorded clear/);
    assert.equal(rest.length, 2);
    const [site, plain] = rest;
    assert.match(site, /<h3 class="cache-card-title">org\/site<\/h3><span class="status-badge success">On<\/span>/);
    assert.match(site, /Pages are kept for 5 minutes and release files for a year\. Visitors who are signed in always get a fresh answer\./);
    assert.match(site, /<hr class="cache-divider">/);
    assert.match(plain, /<span class="status-badge">Off<\/span>/);
    assert.match(plain, /Caching is off\. Cloudflare keeps no copies of this application\./);
    assert.match(plain, /Page freshness[^]*<option value="1" selected>1 minute</);
});

test('a held application says pages are not kept, and its page rows are not shown as cached', () => {
    const data = snapshot();
    data.applications[0].held = { since: '2026-11-27T08:00:00Z', by: 'canary' };
    const html = renderCachePanel({ snapshot: data });
    assert.match(html, /status-badge warning">Held since 2026-11-27T08:00:00Z by canary/);
    assert.match(html, /Page caching is held, so pages are not kept\. Release files are still kept for a year\./);
    assert.match(rowOf(html, '/news'), /Not cached while held/);
    assert.match(rowOf(html, '/v1/*'), /Cached for a year/);
    assert.doesNotMatch(rowOf(html, '/news'), / disabled/, 'route controls stay usable while held');
});

test('the panel markup has no header element and the stylesheet uses only shared tokens', async () => {
    const data = snapshot();
    data.applications[0].held = { since: 's', by: 'b' };
    const html = renderCachePanel({ snapshot: data, results: [{ host: 'first.example', outcome: 'accepted' }], receivedAt: 'now', error: 'e' });
    assert.doesNotMatch(html, /<\/?header[\s>]/i);
    assert.doesNotMatch(await read('web-components/components/cache-panel/cache-panel.html'), /<\/?header[\s>]/i);
    assert.doesNotMatch(await read('web-components/components/cache-panel/cache-panel.js'), /<header[\s>]/i);
    const css = await read('web-components/components/cache-panel/cache-panel.css');
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'no hard-coded colours');
    assert.doesNotMatch(css, /(^|[\s,}])header\b/);
    assert.match(css, /@media \(max-width: 900px\)/);
    assert.match(css, /@media \(max-width: 480px\)/);
    assert.match(css, /\.cache-panel \.cache-freshness select \{ width: auto;/);
    assert.match(css, /\.cache-panel \.plugin-settings-toggle\.cache-route-switch\.enabled \.plugin-settings-switch-thumb \{ transform: translateX\(14px\); \}/);
    assert.doesNotMatch(css, /cache-confirm|cache-routes-table|cache-locked/);
});

test('the switch shows its on state in the cache section, as in Plugins', async () => {
    const data = snapshot();
    const html = renderCachePanel({ snapshot: data });
    const [onApp, offApp] = html.split('<article').slice(1);
    assert.match(onApp, /<button type="button" role="switch" aria-checked="true" class="plugin-settings-toggle enabled" data-cache-toggle="org\/site" aria-label="Caching for org\/site">/);
    assert.match(onApp, /class="plugin-settings-switch-track"[^]*class="plugin-settings-switch-thumb"/);
    assert.match(offApp, /aria-checked="false" class="plugin-settings-toggle" data-cache-toggle="org\/plain"/);
    const css = await read('web-components/modals/settings-modal/settings-modal.css');
    const rules = css.split('}').map((rule) => rule.split('{')[0].trim());
    for (const suffix of ['', '.enabled', '.enabled .plugin-settings-switch-track', '.enabled .plugin-settings-switch-thumb']) {
        const selector = `.plugin-settings-toggle${suffix}`;
        const rule = rules.find((candidate) => candidate.includes(`[data-section="plugins"] ${selector}`));
        assert.ok(rule, `Plugins rule for ${selector}`);
        assert.ok(rule.includes(`settings-modal [data-section="cache"] ${selector}`), `cache section shares the rule for ${selector}`);
    }
    assert.match(await read('web-components/modals/settings-modal/settings-modal.html'), /data-section="cache"/);
});

test('each visible row shows its status, source and the switch state, and offers only its own actions', () => {
    const html = renderCachePanel({ snapshot: snapshot() });
    // [path, actions in the row, switch aria-checked, status, source]
    const rows = [
        ['/news', ['check', 'off'], 'true', 'Cached for 5 minutes', 'from the application'],
        ['/v1/*', ['off'], 'true', 'Cached for a year', 'from the application'],
        ['/about', ['check', 'page'], 'false', 'Not cached', 'not marked by the application'],
        ['/pricing', ['check', 'default'], 'false', 'Not cached', 'switched off by an administrator'],
        ['/shared', ['check', 'default'], 'true', 'Cached for 5 minutes', 'added by an administrator'],
    ];
    for (const [path, actions, checked, status, source] of rows) {
        const row = rowOf(html, path);
        assert.deepEqual(actionsOf(row), actions, path);
        assert.equal(switchOf(row)[1], checked, `${path} switch`);
        assert.match(row, new RegExp(`<span class="cache-route-status">${status}</span>`), `${path} status`);
        assert.match(row, new RegExp(`<span class="cache-route-source"[^>]*>${source}</span>`), `${path} source`);
        assert.match(row, /<code class="cache-path" title=/);
    }
    assert.match(rowOf(html, '/pricing'), /title="Set by admin at 2026-11-27T10:00:00Z"/);
    for (const path of ['/news', '/about']) assert.match(rowOf(html, path), />Test<\/button>/);
    assert.doesNotMatch(rowOf(html, '/v1/*'), />Test</, 'a wildcard cannot be tested');
    const stale = rowOf(html, '/old');
    assert.match(stale, /cache-route-stale/);
    assert.match(stale, /<span class="status-badge warning">Stale<\/span>/);
    assert.match(stale, /no longer matches this route/);
    assert.deepEqual(actionsOf(stale), ['default']);
    assert.match(stale, />Remove<\/button>/);
    assert.equal(switchOf(stale), null);
    assert.doesNotMatch(html, /<th |<table|cache-locked/);
});

test('a switch acts at once, with no confirmation, and sends the exact body for its state', async () => {
    const data = snapshot();
    const writes = [];
    let reads = 0;
    const api = {
        setRoute: async (body) => {
            writes.push(body);
            return { application: data.applications[0], purges: [{ host: 'first.example', outcome: 'accepted' }] };
        },
        read: async () => { reads++; return structuredClone(data); },
    };
    const { presenter, element, content } = panel(structuredClone(data), api);
    await presenter.afterRender();
    // [path, switch state before, the one body the switch sends]
    const cases = [
        ['/news', 'true', 'off'],
        ['/pricing', 'false', 'default'],
        ['/about', 'false', 'page'],
        ['/shared', 'true', 'default'],
    ];
    for (const [path, checked, setting] of cases) {
        const row = rowOf(content.innerHTML, path);
        assert.deepEqual(switchOf(row).slice(1, 3), [checked, setting], path);
        click(element, buttonFrom(row, /role="switch"/));
        await settle();
        assert.deepEqual(writes.at(-1), { agent: 'org/site', path, setting }, path);
        assert.deepEqual(Object.keys(writes.at(-1)), ['agent', 'path', 'setting']);
    }
    assert.equal(writes.length, 4);
    assert.equal(reads, 4);
    assert.match(content.innerHTML, /first\.example · accepted/);
    assert.doesNotMatch(content.innerHTML, /role="alert"|cache-confirm|<dialog|aria-modal|Confirm|Cancel/);
    // The purge results belong to the Clear cache card, above the application cards.
    const [clear] = content.innerHTML.split('<article');
    assert.match(clear, /Clear request results[^]*first\.example · accepted/);
    // Remove on a stale row sends default
    click(element, buttonFrom(rowOf(content.innerHTML, '/old'), /cache-route-action="default"/));
    await settle();
    assert.deepEqual(writes.at(-1), { agent: 'org/site', path: '/old', setting: 'default' });
});

test('an action the row does not offer is never sent', async () => {
    const calls = [];
    const data = snapshot();
    data.applications[0].publicRoutes.push(
        route('/proto', { publicProtocol: true, choices: ['page'] }),
        route('/covered', { manifest: 'page', neverBy: '/p/*', choices: ['off'] }),
        route('/only-check', { checkable: true, choices: [] }),
    );
    const api = new Proxy({ read: async () => structuredClone(data) }, { get: (target, name) => target[name] || (async (...args) => { calls.push([name, ...args]); return { application: snapshot().applications[0], purges: [], check: {} }; }) });
    const { presenter } = panel(structuredClone(data), api);
    await presenter.afterRender();
    for (const [path, action] of [['/login/', 'off'], ['/login/', 'page'], ['/login/', 'default'], ['/login/', 'check'], ['/p/abc', 'default'], ['/old', 'check'], ['/old', 'off'], ['/old', 'page'],
        ['/news', 'page'], ['/news', 'default'], ['/v1/*', 'check'], ['/missing', 'off'], ['/proto', 'page'], ['/proto', 'check'], ['/covered', 'off'],
        ['/only-check', 'check'], ['/api/submit', 'page'], ['/files/*', 'page'], ['/about', 'off'], ['/about', 'default'], ['/pricing', 'page'], ['/pricing', 'off'], ['/shared', 'off']]) {
        await presenter.routeAction(action, 'org/site', path);
    }
    for (const action of ['confirm', 'cancel', 'toString', '__proto__', 'constructor', '']) await presenter.routeAction(action, 'org/site', '/news');
    assert.deepEqual(calls, []);
});

test('a stale row that shares its path with a live row is resolved on its own: Remove posts, nothing leaks between the rows', async () => {
    const data = snapshot();
    // As the Router builds the pair: the live `/news` row ignores the unbound setting (it stays cached,
    // offers off), and the stale twin carries the entry's current mark and offers only the reset.
    data.applications[0].publicRoutes.push(route('/news', {
        manifest: 'page', stale: true, choices: ['default'], setting: { setting: 'off', at: '2026-11-20T09:00:00Z', by: 'admin' },
    }), route('/login/', {
        // As the Router builds it: a stale row carries the entry's current mark, here `never`.
        manifest: 'never', stale: true, choices: ['default'], setting: { setting: 'page', at: '2026-11-20T09:00:00Z', by: 'admin' },
    }));
    const writes = [];
    const checks = [];
    const api = {
        setRoute: async (body) => { writes.push(body); return { application: data.applications[0], purges: [] }; },
        checkRoute: async (body) => { checks.push(body); return { check: { host: 'first.example', path: '/news', status: 200, cdnHeader: PAGE, cacheControl: null } }; },
        read: async () => structuredClone(data),
    };
    const { presenter, element, content } = panel(structuredClone(data), api);
    await presenter.afterRender();
    // the never row is hidden; only its stale twin is shown, and it can be removed
    const neverRows = rowsFor(content.innerHTML, '/login/');
    assert.equal(neverRows.length, 1);
    assert.match(neverRows[0], /cache-route-stale/);
    assert.deepEqual(actionsOf(neverRows[0]), ['default']);
    click(element, buttonFrom(neverRows[0], /cache-route-action="default"/));
    await settle();
    assert.deepEqual(writes, [{ agent: 'org/site', path: '/login/', setting: 'default' }]);
    // live row and stale twin on one path: the test result belongs to the live row only
    let [live, stale] = rowsFor(content.innerHTML, '/news');
    assert.deepEqual(actionsOf(live), ['check', 'off']);
    assert.deepEqual(switchOf(live).slice(1, 3), ['true', 'off'], 'the live row shows the route as cached');
    assert.deepEqual(actionsOf(stale), ['default']);
    assert.equal(switchOf(stale), null);
    click(element, buttonFrom(live, /cache-route-action="check"/));
    await settle();
    [live, stale] = rowsFor(content.innerHTML, '/news');
    assert.match(live, /Tested now/);
    assert.doesNotMatch(stale, /Tested now/);
    assert.deepEqual(checks, [{ agent: 'org/site', path: '/news' }]);
    click(element, buttonFrom(stale, /cache-route-action="default"/));
    await settle();
    assert.deepEqual(writes[1], { agent: 'org/site', path: '/news', setting: 'default' });
});

test('Test sends the exact body, shows the result under its row and leaves everything else alone', async () => {
    const data = snapshot();
    const checks = [];
    let reads = 0;
    const pending = deferred();
    const api = {
        checkRoute: (body) => { checks.push(body); return pending.promise; },
        read: async () => { reads++; return data; },
    };
    const { presenter, element, content } = panel(structuredClone(data), api);
    await presenter.afterRender();
    click(element, buttonFrom(rowOf(content.innerHTML, '/news'), /cache-route-action="check"/));
    assert.deepEqual(checks, [{ agent: 'org/site', path: '/news' }]);
    assert.deepEqual(Object.keys(checks[0]), ['agent', 'path']);
    assert.match(rowOf(content.innerHTML, '/news'), />Testing…<\/button>/);
    pending.resolve({ check: { host: 'first.example', path: '/news', status: 200, cdnHeader: PAGE, cacheControl: 'public, max-age=60' } });
    await settle();
    assert.match(rowOf(content.innerHTML, '/news'), /<p class="cache-check" role="status"><strong>Tested now:<\/strong> HTTP 200 from first\.example\/news\. Cloudflare header sent: <code>max-age=300, stale-if-error=900<\/code>\. Application header: <code>public, max-age=60<\/code>/);
    assert.doesNotMatch(rowOf(content.innerHTML, '/about'), /Tested now/);
    assert.equal(reads, 0);
    assert.equal(presenter.error, '');
    assert.doesNotMatch(content.innerHTML, /data-cache-toggle="org\/site"[^>]* disabled/);
});

test('Test failures are explained under the row and never lock the panel', async () => {
    const cases = [
        [{ status: 429, code: 'rate_limited', retryAfterSeconds: 1 }, /Tests are limited to one per second\. Try again in 1 second\./],
        [{ status: 429, code: 'rate_limited', retryAfterSeconds: 3 }, /Try again in 3 seconds\./],
        [{ status: 409, code: 'no_published_host' }, /No published host sends this path to the application/],
        [{ status: 400, code: 'wildcard_path' }, /Only an exact path can be tested/],
        [{ status: 404, code: 'unknown_route' }, /no longer a public route/],
        [{ status: 503, code: 'cache_unavailable' }, /could not fetch this page/],
        [{ status: 500, code: 'boom' }, /test could not be completed/],
    ];
    for (const [failure, expected] of cases) {
        const { presenter, content } = panel(snapshot(), { checkRoute: async () => { throw Object.assign(new Error(failure.code), failure); } });
        await presenter.afterRender();
        await presenter.routeAction('check', 'org/site', '/news');
        assert.match(rowOf(content.innerHTML, '/news'), expected);
        assert.match(rowOf(content.innerHTML, '/news'), /class="cache-check error"/);
        assert.doesNotMatch(content.innerHTML, / disabled/, 'controls stay usable');
    }
});

test('a Router refusal of a route change is explained in plain words, the list is re-read and controls stay usable', async () => {
    const messages = {
        unknown_application: /no longer listed/,
        unknown_route: /no longer a public route/,
        route_never: /forbids caching this route/,
        route_marked: /already marks this route/,
        route_uncached: /nothing to switch off/,
        route_not_choosable: /cannot be allowed on this route/,
    };
    for (const [code, expected] of Object.entries(messages)) {
        let reads = 0;
        const api = {
            setRoute: async () => { throw Object.assign(new Error(code), { status: code.startsWith('unknown') ? 404 : 400, code }); },
            read: async () => { reads++; return snapshot(); },
        };
        const { presenter, content } = panel(snapshot(), api);
        await presenter.afterRender();
        await presenter.routeAction('default', 'org/site', '/pricing');
        assert.match(content.innerHTML, expected, code);
        assert.match(content.innerHTML, /role="alert"/);
        assert.equal(reads, 1, code);
        assert.doesNotMatch(content.innerHTML, /data-cache-toggle="org\/site"[^>]* disabled/, code);
    }
});

test('an unknown outcome keeps controls locked until Refresh', async () => {
    let fail = true;
    const api = {
        setRoute: async () => { throw Object.assign(new Error('boom'), { status: 500, code: 'boom' }); },
        read: async () => { if (fail) throw new Error('transport'); return snapshot(); },
    };
    const { presenter, content } = panel(snapshot(), api);
    await presenter.afterRender();
    await presenter.routeAction('default', 'org/site', '/pricing');
    assert.match(content.innerHTML, /Could not confirm the cache request\. Refresh before trying again\./);
    assert.match(content.innerHTML, /data-cache-toggle="org\/site"[^>]* disabled/);
    assert.equal(presenter.routeAction('default', 'org/site', '/pricing'), undefined);
    await presenter.refresh();
    assert.match(content.innerHTML, /Could not refresh cache settings/);
    assert.match(content.innerHTML, /data-cache-toggle="org\/site"[^>]* disabled/);
    fail = false;
    await presenter.refresh();
    assert.equal(presenter.error, '');
    assert.doesNotMatch(content.innerHTML, /data-cache-toggle="org\/site"[^>]* disabled/);
});

test('without publicRoutes (older Router) the tab shows the marked paths as a plain list, with no route controls', async () => {
    const { presenter, content } = panel(v1Snapshot(), {});
    await presenter.afterRender();
    const html = content.innerHTML;
    assert.match(html, /class="plugin-settings-toggle enabled" data-cache-toggle="org\/site"/);
    assert.match(html, /<option value="5" selected>5 minutes/);
    assert.match(html, /cache-routes-plain/);
    assert.match(html, /<span>Routes<\/span><span class="status-badge">2<\/span>/);
    assert.match(html, /<code class="cache-path" title="\/news">\/news<\/code>\s*<span class="cache-route-status">Cached for 5 minutes<\/span>\s*<span class="cache-route-source">from the application/);
    assert.match(html, /<code class="cache-path" title="\/v1">\/v1<\/code>\s*<span class="cache-route-status">Cached for a year<\/span>/);
    assert.match(html, /data-purge-host="first\.example"/);
    assert.match(html, /data-purge-host="second\.example"/);
    assert.doesNotMatch(html, /data-cache-route-action|role="switch" aria-checked="(true|false)" aria-label|cache-route-controls|>Test</);
    assert.doesNotMatch(html, /<\/?header[\s>]/i);
});

test('loads, shows loading first, and renders minutes and the Cloudflare disclosure', async () => {
    const data = snapshot();
    data.hosts[1].purgeConfigured = false;
    const pending = deferred();
    const { presenter, content } = panel(null, { read: () => pending.promise });
    const loading = presenter.afterRender();
    assert.match(content.innerHTML, /Loading cache settings/);
    pending.resolve(data);
    await loading;
    assert.match(content.innerHTML, /<option value="5" selected>5 minutes/);
    assert.match(content.innerHTML, /<option value="1" selected>1 minute</);
    assert.match(content.innerHTML, /cannot see Cloudflare’s rules or cached objects/);
    assert.match(content.innerHTML, /data-purge-host="second\.example" disabled/);
    assert.match(content.innerHTML, /Purge unconfigured/);
    assert.match(content.innerHTML, /Published on first\.example, second\.example/);
    assert.match(content.innerHTML, /<span class="status-badge success">On<\/span>/);
    assert.match(content.innerHTML, /<span class="status-badge">Off<\/span>/);
});

test('the switch and freshness send complete settings and reject unsupported minute choices', async () => {
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
        await settle();
    }
    assert.deepEqual(writes, [60, 120, 300].map((pageSeconds) => ({ agent: 'org/site', enabled: true, pageSeconds })));
    assert.match(content.innerHTML, /value="5" selected/);
    click(element, buttonFrom(content.innerHTML, /data-cache-toggle="org\/site"/));
    await settle();
    assert.deepEqual(writes[3], { agent: 'org/site', enabled: false, pageSeconds: 300 });
    assert.match(content.innerHTML, /aria-checked="false" class="plugin-settings-toggle" data-cache-toggle="org\/site"/);
});

test('switch-off shows each result before the follow-up read supplies the last clear time and actor', async () => {
    const data = snapshot();
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
    await settle();
    assert.match(content.innerHTML, /first.example · accepted/);
    assert.match(content.innerHTML, /second.example · failed/);
    assert.match(content.innerHTML, /third.example · unconfigured/);
    assert.match(content.innerHTML, /Response received at \d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(content.innerHTML, /aria-checked="true" class="plugin-settings-toggle enabled" data-cache-toggle="org\/site"|Last recorded clear:/);
    refresh.resolve({
        applications: [app],
        hosts: data.hosts.map((host, i) => ({
            ...host, lastPurge: { ...purges[i], at: '2026-11-23T10:00:00Z', by: 'admin' },
        })),
    });
    await action;
    assert.match(content.innerHTML, /Last recorded clear: failed at 2026-11-23T10:00:00Z by admin/);
    assert.doesNotMatch(content.innerHTML, /plugin-settings-toggle enabled" data-cache-toggle="org\/site"/);
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
    for (const host of ['first.example', 'second.example']) click(element, { dataset: { purgeHost: host }, hasAttribute: () => false });
    assert.deepEqual(writes, [{ host: 'first.example' }]);
    pending.resolve({ purge: { host: 'first.example', outcome: 'cooldown', retryAfterSeconds: 12 } });
    await settle();
    assert.match(content.innerHTML, /first.example · cooldown \(retry after 12 seconds\)/);
    assert.match(content.innerHTML, /Response received at \d{4}-\d{2}-\d{2}T/);
    assert.match(content.innerHTML, /Could not refresh/);
    assert.match(content.innerHTML, /data-cache-toggle="org\/site"[^>]* disabled/);
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

test('a denied Check also drops protected state and bubbles to Settings', async () => {
    const { presenter, element, content } = panel(snapshot(), { checkRoute: async () => { throw Object.assign(new Error('x'), { status: 401 }); } });
    const denials = [];
    element.addEventListener('cache-access-denied', (event) => denials.push(event.bubbles));
    await presenter.afterRender();
    await presenter.routeAction('check', 'org/site', '/news');
    assert.deepEqual(denials, [true]);
    assert.equal(presenter.snapshot, null);
    assert.equal(content.textContent, 'Administrator access is required.');
});

test('returning to the tab reads again and renders an empty application list', async () => {
    const { presenter, element, content } = panel(snapshot(), { read: async () => ({ applications: [], hosts: [] }) });
    await presenter.afterRender();
    element.dispatchEvent(new CustomEvent('cache-active', { detail: false }));
    element.dispatchEvent(new CustomEvent('cache-active', { detail: true }));
    await settle();
    assert.match(content.innerHTML, /No applications have cacheable paths/);
});

test('closing Settings before WebSkel finishes loading the presenter prevents its first read', async () => {
    let reads = 0;
    const { presenter, element } = panel(null, { read: async () => { reads++; return snapshot(); } });
    element.isConnected = false;
    await presenter.afterRender();
    assert.equal(reads, 0);
});
