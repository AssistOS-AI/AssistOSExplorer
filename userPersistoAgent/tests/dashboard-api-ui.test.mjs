import test from 'node:test';
import assert from 'node:assert/strict';
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
    const document = { querySelectorAll: () => links };
    updateAccountNavigation(document, { roles: ['admin'] });
    assert.deepEqual(links.map((link) => link.hidden), [true, true]);
    updateAccountNavigation(document, { capabilities: ['admin.users.manage'] });
    assert.deepEqual(links.map((link) => link.hidden), [false, true]);
    updateAccountNavigation(document, { capabilities: ['admin.agentSettings.manage'] });
    assert.deepEqual(links.map((link) => link.hidden), [true, false]);
    updateAccountNavigation(document, null);
    assert.deepEqual(links.map((link) => link.hidden), [true, true]);
});
