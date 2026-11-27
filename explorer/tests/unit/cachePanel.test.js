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

function rowOf(html, path) {
    const row = html.split('<tr data-cache-route>').slice(1).map((chunk) => chunk.split('</tr>')[0]).find((chunk) => chunk.includes(`title="${path}"`));
    assert.ok(row, `no row for ${path}`);
    return row;
}

const actionsOf = (row) => [...row.matchAll(/data-cache-route-action="([a-z]+)"/g)].map((match) => match[1]);

test('renders hosts strip, switch, freshness and one table per application, and escapes every Router value', async () => {
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
        route('/p/x', { neverBy: '<i>/p/*</i>', source: 'never' }),
    ];
    data.hosts = [{ host: hostile, purgeConfigured: false, lastPurge: { outcome: hostile, at: '<u>t</u>', by: '<s>a</s>' } }];
    const { presenter, content } = panel(data, {
        checkRoute: async () => ({ check: { host: hostile, path: '<svg>', status: hostile, cdnHeader: '<p>x</p>', cacheControl: '"><b>' } }),
    });
    await presenter.afterRender();
    await presenter.routeAction('check', app.agent, '<script>');
    const html = content.innerHTML;
    assert.match(html, /Held since 2026-11-23T01:00:00Z by &lt;img src=x onerror=1&gt;/);
    assert.match(html, /data-cache-toggle="org\/&quot; onclick=&quot;bad" disabled/);
    assert.match(html, /title="&lt;script&gt;"/);
    assert.match(html, /Covered by &lt;i&gt;\/p\/\*&lt;\/i&gt;/);
    assert.match(html, /Set by &lt;b&gt;who&lt;\/b&gt; at &lt;img/);
    assert.match(html, /Checked now:<\/strong> HTTP &lt;img[^]*&lt;svg&gt;/);
    assert.doesNotMatch(html, /<img|<script|<svg>|<b>|<i>|<u>|<s>|<p>x| onclick="/);
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
});

test('the switch shows its on state in the cache section, as in Plugins', async () => {
    const data = snapshot();
    const html = renderCachePanel({ snapshot: data });
    const [onApp, offApp] = html.split('<article').slice(1);
    assert.match(onApp, /<button type="button" role="switch" aria-checked="true" class="plugin-settings-toggle enabled" data-cache-toggle="org\/site">/);
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

test('rows show mark, header and only the actions each row offers: never rows none, stale rows only Reset', async () => {
    const html = renderCachePanel({ snapshot: snapshot() });
    for (const label of ['Path', 'Mark', 'Cloudflare header for an anonymous request', 'Actions']) assert.match(html, new RegExp(`<th scope="col">${label}</th>`));
    const rows = new Map([
        ['/news', ['off', 'check']],
        ['/v1/*', ['off']],
        ['/about', ['page', 'check']],
        ['/pricing', ['default', 'check']],
        ['/shared', ['default', 'check']],
        ['/login/', []],
        ['/p/abc', []],
        ['/old', ['default']],
        ['/api/submit', []],
        ['/files/*', []],
    ]);
    for (const [path, actions] of rows) assert.deepEqual(actionsOf(rowOf(html, path)), actions, path);
    const news = rowOf(html, '/news');
    assert.match(news, />Manifest page<\/span>/);
    assert.match(news, new RegExp(`<code>${PAGE}</code>`));
    assert.match(news, />Switch off<\/button>/);
    assert.match(rowOf(html, '/v1/*'), />Manifest immutable<\/span>/);
    assert.match(rowOf(html, '/about'), />Not cached<\/span>[^]*<code>no-store<\/code>[^]*>Allow caching<\/button>/);
    assert.match(rowOf(html, '/pricing'), />Switched off<\/span>[^]*Manifest page[^]*Set by admin at 2026-11-27T10:00:00Z[^]*>Reset<\/button>/);
    assert.match(rowOf(html, '/shared'), />Added by administrator<\/span>/);
    for (const path of ['/login/', '/p/abc']) {
        const row = rowOf(html, path);
        assert.match(row, />Never<\/span>/);
        assert.match(row, /class="cache-locked"[^]*Locked/);
        assert.doesNotMatch(row, /<button/);
    }
    assert.match(rowOf(html, '/p/abc'), /Covered by \/p\/\*/);
    for (const path of ['/api/submit', '/files/*']) {
        const row = rowOf(html, path);
        assert.match(row, />Not cached<\/span>/);
        assert.doesNotMatch(row, /<button|cache-locked|Locked/, `${path} is not a never route, so it has no lock`);
    }
    const stale = rowOf(html, '/old');
    assert.match(stale, />Stale<\/span>/);
    assert.match(stale, /no longer matches this route/);
    assert.deepEqual([...stale.matchAll(/<button/g)].length, 1);
    assert.doesNotMatch(html, /<header/i);
    assert.match(html, /Caching can be allowed on other routes only after the application marks at least one route as never cached\./);
});

test('Switch off and Allow caching ask inside the row first, then send the exact route body', async () => {
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
    click(element, buttonFrom(rowOf(content.innerHTML, '/news'), /cache-route-action="off"/));
    assert.deepEqual(writes, []);
    let news = rowOf(content.innerHTML, '/news');
    assert.match(news, /role="alert">Switch off caching for this route\?/);
    assert.deepEqual(actionsOf(news), ['confirm', 'cancel']);
    assert.doesNotMatch(content.innerHTML, /<dialog|role="dialog"|aria-modal/);
    click(element, buttonFrom(news, /cache-route-action="cancel"/));
    assert.deepEqual(writes, []);
    assert.deepEqual(actionsOf(rowOf(content.innerHTML, '/news')), ['off', 'check']);
    click(element, buttonFrom(rowOf(content.innerHTML, '/news'), /cache-route-action="off"/));
    click(element, buttonFrom(rowOf(content.innerHTML, '/news'), /cache-route-action="confirm"/));
    await settle();
    assert.deepEqual(writes, [{ agent: 'org/site', path: '/news', setting: 'off' }]);
    assert.equal(reads, 1);
    assert.match(content.innerHTML, /first\.example · accepted/);

    click(element, buttonFrom(rowOf(content.innerHTML, '/about'), /cache-route-action="page"/));
    news = rowOf(content.innerHTML, '/about');
    assert.match(news, /Allow Cloudflare to cache this route for 5 minutes\?/);
    click(element, buttonFrom(news, /cache-route-action="confirm"/));
    await settle();
    assert.deepEqual(writes[1], { agent: 'org/site', path: '/about', setting: 'page' });
    assert.deepEqual(Object.keys(writes[1]), ['agent', 'path', 'setting']);

    for (const path of ['/pricing', '/old']) {
        click(element, buttonFrom(rowOf(content.innerHTML, path), /cache-route-action="default"/));
        await settle();
    }
    assert.deepEqual(writes.slice(2), [{ agent: 'org/site', path: '/pricing', setting: 'default' }, { agent: 'org/site', path: '/old', setting: 'default' }]);
});

test('an action the row does not offer is never sent', async () => {
    const calls = [];
    const api = new Proxy({ read: async () => snapshot() }, { get: (target, name) => target[name] || (async (...args) => { calls.push([name, ...args]); return { application: snapshot().applications[0], purges: [], check: {} }; }) });
    const { presenter } = panel(snapshot(), api);
    await presenter.afterRender();
    for (const [path, action] of [['/login/', 'off'], ['/login/', 'page'], ['/login/', 'check'], ['/p/abc', 'default'], ['/old', 'check'], ['/old', 'off'],
        ['/news', 'page'], ['/news', 'default'], ['/v1/*', 'check'], ['/missing', 'off']]) {
        await presenter.routeAction(action, 'org/site', path);
        await presenter.routeAction('confirm', 'org/site', path);
    }
    assert.equal(presenter.confirming, null);
    assert.deepEqual(calls, []);
});

test('a stale row that shares its path with a live row is resolved on its own: Reset posts, nothing leaks between the rows', async () => {
    const data = snapshot();
    data.applications[0].publicRoutes.push(route('/news', {
        stale: true, choices: ['default'], setting: { setting: 'page', at: '2026-11-20T09:00:00Z', by: 'admin' },
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
    const rowsFor = (path) => content.innerHTML.split('<tr data-cache-route>').slice(1).map((chunk) => chunk.split('</tr>')[0]).filter((chunk) => chunk.includes(`title="${path}"`));
    // never row and its stale twin on one path: only the twin can be reset
    const [never, neverStale] = rowsFor('/login/');
    assert.deepEqual(actionsOf(never), []);
    assert.deepEqual(actionsOf(neverStale), ['default']);
    click(element, buttonFrom(neverStale, /cache-route-action="default"/));
    await settle();
    assert.deepEqual(writes, [{ agent: 'org/site', path: '/login/', setting: 'default' }]);
    // live row and stale twin on one path: confirm and check state belong to the live row only
    let [live, stale] = rowsFor('/news');
    assert.deepEqual(actionsOf(live), ['off', 'check']);
    assert.deepEqual(actionsOf(stale), ['default']);
    click(element, buttonFrom(live, /cache-route-action="off"/));
    [live, stale] = rowsFor('/news');
    assert.deepEqual(actionsOf(live), ['confirm', 'cancel']);
    assert.deepEqual(actionsOf(stale), ['default']);
    click(element, buttonFrom(live, /cache-route-action="cancel"/));
    click(element, buttonFrom(rowsFor('/news')[0], /cache-route-action="check"/));
    await settle();
    [live, stale] = rowsFor('/news');
    assert.match(live, /Checked now/);
    assert.doesNotMatch(stale, /Checked now/);
    assert.deepEqual(checks, [{ agent: 'org/site', path: '/news' }]);
    click(element, buttonFrom(stale, /cache-route-action="default"/));
    await settle();
    assert.deepEqual(writes[1], { agent: 'org/site', path: '/news', setting: 'default' });
});

test('Check sends the exact body, shows the result in its row and leaves everything else alone', async () => {
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
    assert.match(rowOf(content.innerHTML, '/news'), />Checking…<\/button>/);
    pending.resolve({ check: { host: 'first.example', path: '/news', status: 200, cdnHeader: PAGE, cacheControl: 'public, max-age=60' } });
    await settle();
    assert.match(rowOf(content.innerHTML, '/news'), /Checked now:<\/strong> HTTP 200 from first\.example\/news\. Cloudflare header sent: <code>max-age=300, stale-if-error=900<\/code>\. Application header: <code>public, max-age=60<\/code>/);
    assert.doesNotMatch(rowOf(content.innerHTML, '/about'), /Checked now/);
    assert.equal(reads, 0);
    assert.equal(presenter.error, '');
    assert.doesNotMatch(content.innerHTML, /data-cache-toggle="org\/site"[^>]* disabled/);
});

test('Check failures are explained in the row and never lock the panel', async () => {
    const cases = [
        [{ status: 429, code: 'rate_limited', retryAfterSeconds: 1 }, /Checks are limited to one per second\. Try again in 1 second\./],
        [{ status: 429, code: 'rate_limited', retryAfterSeconds: 3 }, /Try again in 3 seconds\./],
        [{ status: 409, code: 'no_published_host' }, /No published host sends this path to the application/],
        [{ status: 400, code: 'wildcard_path' }, /Only an exact path can be checked/],
        [{ status: 404, code: 'unknown_route' }, /no longer a public route/],
        [{ status: 503, code: 'cache_unavailable' }, /could not fetch this page/],
        [{ status: 500, code: 'boom' }, /check could not be completed/],
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

test('without publicRoutes (older Router) the tab shows the v1 content in the new design, with no route controls', async () => {
    const { presenter, content } = panel(v1Snapshot(), {});
    await presenter.afterRender();
    const html = content.innerHTML;
    assert.match(html, /class="plugin-settings-toggle enabled" data-cache-toggle="org\/site"/);
    assert.match(html, /<option value="5" selected>5 minutes/);
    assert.match(html, /cache-routes-plain/);
    assert.match(html, /<code class="cache-path" title="\/news">\/news<\/code>[^]*Manifest page/);
    assert.match(html, /<code class="cache-path" title="\/v1">\/v1<\/code>[^]*Manifest immutable/);
    assert.match(html, /data-purge-host="first\.example"/);
    assert.match(html, /data-purge-host="second\.example"/);
    assert.doesNotMatch(html, /data-cache-route-action|<th scope="col">Actions|Cloudflare header for an anonymous request|cache-locked/);
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
