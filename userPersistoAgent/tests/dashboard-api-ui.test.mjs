import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { callManagementTool, updateAccountNavigation } from '../public/dashboard/api.mjs';

function response(payload, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('management reads use profile GET and fixed admin POST routes with same-origin credentials', async (t) => {
    const calls = [];
    const profile = { user: { id: 'actor' }, capabilities: ['admin.users.manage'] };
    const result = { users: [], totalCount: 0 };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        return response(options.method === 'GET' ? { ok: true, profile } : { ok: true, result });
    });
    assert.deepEqual(await callManagementTool('userpersisto_profile_get'), profile);
    assert.deepEqual(await callManagementTool('userpersisto_user_list', { search: '../applications/rotate', start: 0 }), result);
    assert.ok(calls[0].url.pathname.endsWith('/dashboard/api/profile'));
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.body, undefined);
    assert.ok(calls[1].url.pathname.endsWith('/dashboard/api/admin/users/list'));
    assert.equal(calls[1].url.search, '', 'arguments travel only in the POST body, never the query string');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[1].options.body), { search: '../applications/rotate', start: 0 });
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[1].options.credentials, 'same-origin');
});

test('management tool names cannot select arbitrary routes or inherited object properties', async (t) => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; return response({ ok: true }); });
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '', '../policy/set', 'https://attacker.test', 'userpersisto_config_set', 'userpersisto_profile_update']) {
        await assert.rejects(callManagementTool(name, {}), /Unknown account action/, name);
    }
    assert.equal(requests, 0);
});

test('management failures preserve authorization metadata and malformed JSON fails closed', async (t) => {
    for (const [payload, status, expected] of [
        [{ ok: false, error: 'admin_required' }, 403, 'admin_required'],
        [{ ok: false, error: 'authentication_required' }, 401, 'authentication_required'],
        [{ ok: true, result: { ok: false, error: 'invalid_email' } }, 200, 'invalid_email'],
        [{ ok: false }, 500, 'Unable to complete'],
    ]) {
        t.mock.method(globalThis, 'fetch', async () => response(payload, status));
        await assert.rejects(callManagementTool('userpersisto_user_update', { userId: 'id' }), (error) => {
            assert.equal(error.statusCode, status);
            assert.equal(error.payload, payload);
            assert.match(error.message, new RegExp(expected));
            return true;
        });
    }
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => { throw new Error('Bad JSON'); } }));
    await assert.rejects(callManagementTool('userpersisto_oidc_status'), /Unable to complete/);
});

test('management tool map no longer exposes retired account-creation or password routes', async (t) => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; return response({ ok: true }); });
    for (const name of ['userpersisto_user_create', 'userpersisto_auth_password_set']) {
        await assert.rejects(callManagementTool(name, {}), /Unknown account action/, name);
    }
    assert.equal(requests, 0, 'retired routes never reach the network');
});

test('account navigation hides each management link without its capability, including after revocation', () => {
    const links = ['admin.users.manage', 'admin.agentSettings.manage'].map((capability) => ({ dataset: { capability }, hidden: false }));
    const document = { querySelectorAll: selector => selector === '[data-capability]' ? links : [] };
    updateAccountNavigation(document, { roles: ['admin'] });
    assert.deepEqual(links.map((link) => link.hidden), [true, true]);
    updateAccountNavigation(document, { capabilities: ['admin.users.manage'] });
    assert.deepEqual(links.map((link) => link.hidden), [false, true]);
    updateAccountNavigation(document, { capabilities: ['admin.agentSettings.manage'] });
    assert.deepEqual(links.map((link) => link.hidden), [true, false]);
    updateAccountNavigation(document, null);
    assert.deepEqual(links.map((link) => link.hidden), [true, true]);
});

test('view configuration narrows capabilities and persists across provider navigation', () => {
    for (const view of ['account', 'administration', 'invalid', '']) {
        for (const capabilities of [[], ['admin.users.manage'], ['admin.agentSettings.manage'], ['admin.users.manage', 'admin.agentSettings.manage']]) {
            const links = [
                ['./', undefined], ['users.html', 'admin.users.manage'], ['roles.html', 'admin.users.manage'],
                ['applications.html', 'admin.agentSettings.manage'], ['authentication.html', 'admin.agentSettings.manage'],
            ].map(([href, capability]) => ({ dataset: { capability }, href,
                getAttribute() { return this.href; }, setAttribute(_name, value) { this.href = value; } }));
            const document = { baseURI: 'https://example.test/service/dashboard/users.html',
                defaultView: { location: { search: `?view=${view}&showSignOut=0` } },
                querySelectorAll: selector => selector === '[data-capability]' ? links.slice(1) : links };
            updateAccountNavigation(document, { roles: ['admin'], capabilities });
            links.forEach((link, index) => {
                const permitted = index === 0 || capabilities.includes(link.dataset.capability);
                assert.equal(link.hidden, !permitted || view === 'account' || (view === 'administration' && index === 0));
                const url = new URL(link.href, document.baseURI);
                assert.equal(url.searchParams.get('view'), ['account', 'administration'].includes(view) ? view : null);
                assert.equal(url.searchParams.get('showSignOut'), '0');
            });
            updateAccountNavigation(document, null);
            assert.ok(links.slice(1).every(link => link.hidden));
        }
    }
});

test('every account page keeps sign out with the page heading and navigation in its own header', async () => {
    for (const [file, href] of [['index.html', './'], ['users.html', 'users.html'], ['roles.html', 'roles.html'], ['applications.html', 'applications.html'], ['authentication.html', 'authentication.html']]) {
        const html = await readFile(new URL(`../public/dashboard/${file}`, import.meta.url), 'utf8');
        assert.deepEqual([...html.matchAll(/<a href="([^"]+)"[^>]* aria-current="page"/g)].map((match) => match[1]), [href], file);
        const header = html.match(/<header class="account-header">([\s\S]*?)<\/header>/)?.[1];
        assert.ok(header, file);
        assert.doesNotMatch(header, /account-sign-out/, file);
        assert.match(html, /<div class="page-heading"><div class="page-heading-copy">[\s\S]*?<\/div><a class="account-sign-out" href="\/auth\/logout">Sign out<\/a><\/div>/, file);
        assert.equal([...html.matchAll(/class="account-sign-out"/g)].length, 1, file);
        assert.doesNotMatch(html, /account-brand|>UserPersisto<\/a>/, file);
    }
});

test('the authentication policy description names every way the first administrator is claimed', async () => {
    const html = await readFile(new URL('../public/dashboard/authentication.html', import.meta.url), 'utf8');
    const [description] = html.match(/<div class="userpersisto-card-description">Administrator controls[^<]*<\/div>/) || [];
    assert.ok(description);
    assert.match(description, /initial password admin/);
    assert.match(description, /password sign-up \(verified or direct\)/);
    assert.match(description, /Google sign-in/);
    assert.doesNotMatch(description, /first completed verified sign-up or Google sign-in/);
});
