import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../IDE-plugins/userpersisto-settings/userpersisto-settings.js', import.meta.url), 'utf8');
const { UserpersistoSettings } = await import(`data:text/javascript;base64,${Buffer.from(source.replace(/^import[\s\S]*?;\s*/, '')).toString('base64')}`);

function fixture() {
    const panel = new UserpersistoSettings({}, () => {});
    panel.state.authProfile = { roles: ['admin'] };
    panel.authMethodInputs = Object.fromEntries(['password', 'google'].map((method) => [method, { checked: false }]));
    panel.googleStatusEl = {};
    panel.authPolicySourceEl = {};
    return panel;
}

test('Google policy distinguishes enabled from unavailable and shows only safe readiness fields', async () => {
    const panel = fixture();
    panel.callTool = async (name) => name === 'userpersisto_auth_policy_get' ? {
        enabledAuthMethods: ['password', 'google'], environmentOverrides: ['USERPERSISTO_AUTH_METHODS'],
    } : {
        enabled: true, available: false, configured: false,
        missing: ['USERPERSISTO_GOOGLE_CLIENT_SECRET'], secretPresent: false,
        clientId: 'test-client', redirectUri: 'http://127.0.0.1:8080/base-agent-additional-server/userPersistoAgent/7000/service/auth/google/callback',
        configurationSource: 'environment', reason: 'configuration_missing',
        clientSecret: 'must-never-display', tokens: ['must-never-retain'],
    };
    await panel.refreshAuthPolicy();
    assert.equal(panel.authMethodInputs.google.checked, true);
    assert.match(panel.googleStatusEl.textContent, /Google is unavailable/);
    assert.match(panel.googleStatusEl.textContent, /USERPERSISTO_GOOGLE_CLIENT_SECRET/);
    assert.match(panel.googleStatusEl.textContent, /Client secret: missing/);
    assert.match(panel.googleStatusEl.textContent, /Exact callback: http/);
    assert.match(panel.authPolicySourceEl.textContent, /USERPERSISTO_AUTH_METHODS/);
    assert.doesNotMatch(JSON.stringify(panel.state) + panel.googleStatusEl.textContent, /must-never/);
});

test('authorization loss or component removal prevents a pending readiness response from restoring policy', async () => {
    for (const mode of ['authorization', 'unload']) {
        const panel = fixture();
        let release;
        panel.callTool = async (name) => name === 'userpersisto_auth_policy_get'
            ? { enabledAuthMethods: ['google'] }
            : new Promise((resolve) => { release = resolve; });
        const pending = panel.refreshAuthPolicy();
        if (mode === 'authorization') panel.state.authProfile = { roles: ['user'] };
        else panel.afterUnload();
        panel.clearAuthPolicy();
        release({ available: true, configured: true, clientId: 'late-client' });
        await pending;
        assert.equal(panel.authMethodInputs.google.checked, false);
        assert.doesNotMatch(panel.googleStatusEl.textContent, /ready\.|late-client/);
    }
});

test('Google policy save uses the authorized tool and profile renders only safe method names', async () => {
    const panel = fixture();
    panel.authMethodInputs.google.checked = true;
    const calls = [];
    panel.callTool = async (name, args) => { calls.push({ name, args }); return {}; };
    panel.refreshAuthPolicy = async () => {};
    panel.refreshAuthProfile = async () => {};
    await panel.saveAuthPolicy();
    assert.deepEqual(calls[0].args.enabledAuthMethods, ['google']);
    assert.equal(calls[0].name, 'userpersisto_auth_policy_set');
    panel.state.authProfile = { user: { id: 'local' }, roles: ['user'], authMethods: [{ type: 'google', name: 'Google' }] };
    panel.authProfileEl = {};
    panel.renderAuthProfile();
    assert.match(panel.authProfileEl.innerHTML, /Linked sign-in methods: Google/);
    await panel.saveAuthPolicy();
    assert.equal(calls.length, 1);
});

test('a backend authorization denial clears administrative readiness and list data', async () => {
    const panel = fixture();
    const administrativeNode = { hidden: false };
    panel.element.querySelectorAll = () => [administrativeNode];
    panel.state.users = [{ id: 'private-old-row' }];
    panel.state.usersTotal = 1;
    panel.callTool = async () => { throw Object.assign(new Error('Admin access is required.'), { code: 'admin_required', statusCode: 403 }); };
    await panel.refreshAuthPolicy();
    assert.equal(panel.state.authProfile, null);
    assert.deepEqual(panel.state.users, []);
    assert.equal(administrativeNode.hidden, true);
    assert.equal(panel.authMethodInputs.google.checked, false);
    assert.equal(panel.googleStatusEl.textContent, 'Google readiness is unavailable.');
});
