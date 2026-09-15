import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const sourcePath = path.resolve(
    import.meta.dirname,
    '../../web-components/components/admin-settings-panel/admin-settings-panel.js'
);

async function loadAdminSettingsPanel() {
    const source = await fs.readFile(sourcePath, 'utf8');
    const withoutImports = source.replace(/import\s+\{[\s\S]*?\}\s+from\s+'[^']+';\s*/g, '');
    const dependencies = `
        const parseRoles = (roles) => Array.isArray(roles) ? roles : [];
        const fetchUserAdministrationProof = (...args) => globalThis.__adminFetchControlProof(...args);
    `;
    const url = `data:text/javascript;base64,${Buffer.from(dependencies + withoutImports).toString('base64')}`;
    return import(url);
}

function jsonResponse(status, payload) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => payload
    };
}

function installRequestMocks(t, { responses = [], mode = 'control', proofError = null } = {}) {
    const originalFetch = globalThis.fetch;
    const originalProofFetcher = globalThis.__adminFetchControlProof;
    const calls = [];
    let proofCalls = 0;
    globalThis.__adminFetchControlProof = async ({ agentName }) => {
        assert.equal(agentName, 'explorer');
        proofCalls++;
        if (proofError) throw proofError;
        return mode === 'public'
            ? { mode, origin: 'https://explorer.example.test' }
            : { mode, origin: 'http://localhost:8080', csrfToken: `v1.proof-${proofCalls}` };
    };
    globalThis.fetch = async (requestPath, options) => {
        calls.push({
            path: requestPath,
            method: options.method,
            credentials: options.credentials,
            headers: {...options.headers},
            body: options.body
        });
        return responses.shift() || jsonResponse(200, {ok: true});
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalProofFetcher === undefined) delete globalThis.__adminFetchControlProof;
        else globalThis.__adminFetchControlProof = originalProofFetcher;
    });
    return {calls, getProofCalls: () => proofCalls};
}

test('administration reads omit CSRF proof and mutations attach a fresh proof', async (t) => {
    const {calls, getProofCalls} = installRequestMocks(t);
    const {AdminSettingsPanel} = await loadAdminSettingsPanel();
    const panel = Object.create(AdminSettingsPanel.prototype);
    panel.agent = 'explorer';

    await panel.request('/api/agents/explorer/users');
    for (const method of ['POST', 'PATCH', 'DELETE']) {
        await panel.request('/api/agents/explorer/users/local%3Auser', {
            method,
            body: method === 'DELETE' ? undefined : JSON.stringify({name: 'User'})
        });
    }

    assert.equal(getProofCalls(), 3);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers['x-ploinky-csrf-token'], undefined);
    for (const [index, method] of ['POST', 'PATCH', 'DELETE'].entries()) {
        const call = calls[index + 1];
        assert.equal(call.method, method);
        assert.equal(call.credentials, 'include');
        assert.equal(call.headers['x-ploinky-csrf-token'], `v1.proof-${index + 1}`);
    }
});

test('administration mutation retries csrf_invalid once with a new proof', async (t) => {
    const {calls, getProofCalls} = installRequestMocks(t, {
        responses: [
            jsonResponse(403, {ok: false, error: 'csrf_invalid'}),
            jsonResponse(200, {ok: true, user: {id: 'local:user'}})
        ]
    });
    const {AdminSettingsPanel} = await loadAdminSettingsPanel();
    const panel = Object.create(AdminSettingsPanel.prototype);
    panel.agent = 'explorer';

    const payload = await panel.request('/api/agents/explorer/users', {
        method: 'POST',
        body: JSON.stringify({username: 'user'})
    });

    assert.equal(payload.user.id, 'local:user');
    assert.equal(getProofCalls(), 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers['x-ploinky-csrf-token'], 'v1.proof-1');
    assert.equal(calls[1].headers['x-ploinky-csrf-token'], 'v1.proof-2');
});

test('administration mutation does not retry a non-CSRF rejection', async (t) => {
    const {calls, getProofCalls} = installRequestMocks(t, {
        responses: [jsonResponse(403, {ok: false, error: 'forbidden', message: 'Administrator access required.'})]
    });
    const {AdminSettingsPanel} = await loadAdminSettingsPanel();
    const panel = Object.create(AdminSettingsPanel.prototype);
    panel.agent = 'explorer';

    await assert.rejects(
        panel.request('/api/agents/explorer/users/local%3Auser', {method: 'DELETE'}),
        /Administrator access required/
    );
    assert.equal(getProofCalls(), 1);
    assert.equal(calls.length, 1);
});

test('public user mutations use credentials without the local-control header', async (t) => {
    const { calls, getProofCalls } = installRequestMocks(t, { mode: 'public' });
    const { AdminSettingsPanel } = await loadAdminSettingsPanel();
    const panel = Object.create(AdminSettingsPanel.prototype);
    panel.agent = 'explorer';
    for (const [method, path] of [
        ['POST', '/api/agents/explorer/users'],
        ['PATCH', '/api/agents/explorer/users/local%3Auser'],
        ['DELETE', '/api/agents/explorer/users/local%3Auser'],
    ]) {
        await panel.request(path, { method, body: method === 'DELETE' ? undefined : '{}' });
    }
    assert.equal(getProofCalls(), 3);
    for (const call of calls) {
        assert.equal(call.credentials, 'include');
        assert.equal(call.headers['x-ploinky-csrf-token'], undefined);
    }
});

test('public stale-cookie rejection refreshes once and preserves the request', async (t) => {
    const { calls, getProofCalls } = installRequestMocks(t, {
        mode: 'public',
        responses: [
            jsonResponse(403, { ok: false, error: 'browser_csrf_invalid' }),
            jsonResponse(201, { ok: true, user: { id: 'local:new-user' } })
        ]
    });
    const { AdminSettingsPanel } = await loadAdminSettingsPanel();
    const panel = Object.create(AdminSettingsPanel.prototype);
    panel.agent = 'explorer';
    const payload = await panel.request('/api/agents/explorer/users', { method: 'POST', body: '{"username":"new-user"}' });
    assert.equal(payload.user.id, 'local:new-user');
    assert.equal(getProofCalls(), 2);
    assert.deepEqual(calls[0], calls[1]);
});

test('repeated CSRF failures stop after the second attempt', async (t) => {
    const { calls, getProofCalls } = installRequestMocks(t, {
        mode: 'public',
        responses: Array.from({ length: 2 }, () => jsonResponse(403, { ok: false, error: 'browser_csrf_invalid' }))
    });
    const { AdminSettingsPanel } = await loadAdminSettingsPanel();
    const panel = Object.create(AdminSettingsPanel.prototype);
    panel.agent = 'explorer';
    await assert.rejects(panel.request('/api/agents/explorer/users', { method: 'POST' }), /browser_csrf_invalid/);
    assert.equal(getProofCalls(), 2);
    assert.equal(calls.length, 2);
});

test('a rejected proof prevents sending the mutation', async (t) => {
    const { calls, getProofCalls } = installRequestMocks(t, { proofError: new Error('Administrator access required.') });
    const { AdminSettingsPanel } = await loadAdminSettingsPanel();
    const panel = Object.create(AdminSettingsPanel.prototype);
    panel.agent = 'explorer';
    await assert.rejects(panel.request('/api/agents/explorer/users', { method: 'POST' }), /Administrator access required/);
    assert.equal(getProofCalls(), 1);
    assert.equal(calls.length, 0);
});

test('the panel no longer wires user creation or forwards passwords', async () => {
    const source = await fs.readFile(sourcePath, 'utf8');
    assert.doesNotMatch(source, /admin-users-create/);
    assert.doesNotMatch(source, /createUser/);
    assert.doesNotMatch(source, /password/i);
});
