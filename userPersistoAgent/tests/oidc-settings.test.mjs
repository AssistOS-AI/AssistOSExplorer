import test from 'node:test';
import assert from 'node:assert/strict';
import { UserpersistoSettings } from '../public/dashboard/management.mjs';

function fixture() {
    const panel = new UserpersistoSettings({ querySelectorAll: () => [], getAttribute: () => 'applications' }, () => {});
    panel.state.authProfile = { roles: ['admin'], capabilities: ['admin.agentSettings.manage'] };
    panel.state.activePanel = 'applications';
    panel.applicationInputs = Object.fromEntries([
        'client_id', 'client_name', 'redirect_uris', 'post_logout_redirect_uris', 'scope', 'token_endpoint_auth_method', 'enabled'
    ].map((key) => [key, {}]));
    panel.applicationGrantInputs = Object.fromEntries(['authorization_code', 'refresh_token', 'client_credentials'].map((key) => [key, {}]));
    panel.applicationSecretInput = { value: '' };
    panel.applicationSecretBox = { hidden: true };
    panel.applicationsListEl = { innerHTML: '', querySelectorAll: () => [] };
    panel.applicationEditorTitle = {};
    panel.applicationsPreviousButton = {};
    panel.applicationsNextButton = {};
    panel.applicationsPageLabel = {};
    panel.oidcStatusEl = {};
    panel.confirmApplicationAction = async () => true;
    panel.resetApplicationForm();
    return panel;
}

const publicClient = (index) => ({
    client_id: `app-${index}`, client_name: `Application ${index}`, redirect_uris: ['https://app.example/callback'],
    post_logout_redirect_uris: [], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], scope: 'openid', enabled: true
});

test('applications create/edit use structured metadata and show a confidential secret only once', async () => {
    const panel = fixture();
    const calls = [];
    const clients = [];
    panel.callTool = async (name, args) => {
        calls.push({ name, args });
        if (name === 'userpersisto_oidc_client_create') {
            clients.push({ ...args, client_id: 'generated', client_secret: 'must-not-retain' });
            return { client: clients[0], client_secret: 'new-once-secret' };
        }
        if (name === 'userpersisto_oidc_client_update') {
            clients[0] = { ...clients[0], ...args };
            return { client: clients[0] };
        }
        return { items: clients, total: clients.length };
    };
    panel.applicationInputs.client_name.value = 'An app';
    panel.applicationInputs.redirect_uris.value = ' https://app.example/callback \nhttps://app.example/second';
    await panel.saveApplication();
    assert.deepEqual(calls[0], { name: 'userpersisto_oidc_client_create', args: {
        client_name: 'An app', redirect_uris: ['https://app.example/callback', 'https://app.example/second'],
        post_logout_redirect_uris: [], token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code'],
        scope: 'openid profile email', enabled: true
    } });
    assert.equal(panel.applicationSecretInput.value, 'new-once-secret');
    assert.equal(panel.applicationSecretBox.hidden, false);
    assert.doesNotMatch(JSON.stringify(panel.state), /"client_secret":|must-not-retain|new-once/);
    assert.doesNotMatch(panel.applicationsListEl.innerHTML, /must-not-retain|new-once/);
    panel.editApplication(null, 'generated');
    assert.equal(panel.applicationSecretInput.value, '');
    assert.equal(panel.applicationInputs.client_id.disabled, true);
    panel.applicationInputs.client_name.value = 'Renamed';
    await panel.saveApplication();
    assert.equal(calls.find((call) => call.name === 'userpersisto_oidc_client_update').args.client_id, 'generated');
    assert.equal(panel.state.applications[0].client_name, 'Renamed');
    assert.equal(panel.applicationSecretBox.hidden, true);
});

test('application pagination reaches row 601 and deletion returns from an empty final page', async () => {
    const panel = fixture();
    const clients = Array.from({ length: 601 }, (_, index) => publicClient(index));
    panel.callTool = async (name, args) => {
        if (name === 'userpersisto_oidc_client_delete') {
            clients.splice(clients.findIndex((client) => client.client_id === args.client_id), 1);
            return { ok: true };
        }
        if (name === 'userpersisto_oidc_client_update') {
            Object.assign(clients.find((client) => client.client_id === args.client_id), args);
            return {};
        }
        return { items: clients.slice(args.start, args.start + args.pageSize), total: clients.length };
    };
    await panel.loadApplicationsPage();
    for (let page = 0; page < 6; page++) await panel.nextApplicationsPage();
    assert.equal(panel.state.applications[0].client_id, 'app-600');
    assert.equal(panel.applicationsPageLabel.textContent, '601–601 of 601 applications');
    assert.equal(panel.applicationsNextButton.disabled, true);
    await panel.toggleApplication(null, 'app-600');
    assert.equal(panel.state.applications[0].enabled, false);
    assert.equal(panel.state.applicationsStart, 600);
    await panel.deleteApplication(null, 'app-600');
    assert.equal(panel.state.applicationsStart, 500);
    assert.equal(panel.applicationsPageLabel.textContent, '501–600 of 600 applications');
    assert.equal(panel.applicationsNextButton.disabled, true);
    await panel.previousApplicationsPage();
    assert.equal(panel.state.applicationsStart, 400);
});

test('public applications have no secret controls and client metadata is escaped', async () => {
    const panel = fixture();
    const client = { ...publicClient(1), client_name: '<img src=x onerror=alert(1)>', client_id: '" onclick="injected' };
    panel.callTool = async () => ({ items: [client], total: 1 });
    await panel.loadApplicationsPage();
    assert.doesNotMatch(panel.applicationsListEl.innerHTML, /<img|data-client-action="rotate"|" onclick="injected/);
    assert.match(panel.applicationsListEl.innerHTML, /&lt;img/);
    assert.match(panel.applicationsListEl.innerHTML, /&quot; onclick=&quot;injected/);
});

test('backend validation failures preserve form data and restore controls', async () => {
    const panel = fixture();
    panel.applicationInputs.client_name.value = 'Unfinished';
    panel.applicationInputs.redirect_uris.value = 'http://untrusted.example/callback';
    panel.callTool = async () => { throw new Error('invalid_redirect_uri'); };
    await panel.saveApplication();
    assert.equal(panel.applicationInputs.client_name.value, 'Unfinished');
    assert.equal(panel.state.applicationBusy, false);
    assert.equal(panel.state.status, 'invalid_redirect_uri');
    assert.equal(panel.state.statusType, 'error');
    assert.equal(panel.applicationSecretBox.hidden, true);
});

test('page loading failure preserves application page and reenables navigation', async () => {
    const panel = fixture();
    panel.state.applications = [publicClient(1)];
    panel.state.applicationsTotal = 101;
    panel.callTool = async () => { throw new Error('unavailable'); };
    await panel.nextApplicationsPage();
    assert.equal(panel.state.applicationsStart, 0);
    assert.equal(panel.state.applications[0].client_id, 'app-1');
    assert.equal(panel.state.applicationsLoading, false);
    assert.equal(panel.applicationsNextButton.disabled, false);
});

test('nonadministrators cannot load or mutate applications and pending responses do not reveal secrets', async () => {
    const panel = fixture();
    let calls = 0;
    panel.callTool = async () => { calls++; return {}; };
    panel.state.authProfile = { roles: ['user'] };
    await panel.refreshApplications();
    await panel.saveApplication();
    await panel.rotateApplicationSecret(null, 'client');
    await panel.deleteApplication(null, 'client');
    assert.equal(calls, 0);

    panel.state.authProfile = { roles: ['admin'], capabilities: ['admin.agentSettings.manage'] };
    let resolve;
    panel.callTool = () => new Promise((done) => { resolve = done; });
    const pending = panel.saveApplication();
    panel.state.authProfile = null;
    panel.clearApplications();
    resolve({ client: publicClient(1), client_secret: 'no-longer-authorized' });
    await pending;
    assert.equal(panel.applicationSecretInput.value, '');
    assert.equal(panel.applicationSecretBox.hidden, true);
    assert.deepEqual(panel.state.applications, []);
});

test('rotation requires confirmation and the returned secret is cleared when leaving the page', async () => {
    const panel = fixture();
    const calls = [];
    panel.callTool = async (name) => {
        calls.push(name);
        return name === 'userpersisto_oidc_client_rotate_secret' ? { client_secret: 'rotated-once' } : { items: [], total: 0 };
    };
    panel.confirmApplicationAction = async () => false;
    await panel.rotateApplicationSecret(null, 'app');
    assert.deepEqual(calls, []);
    panel.confirmApplicationAction = async () => true;
    await panel.rotateApplicationSecret(null, 'app');
    assert.equal(panel.applicationSecretInput.value, 'rotated-once');
    panel.afterUnload();
    assert.equal(panel.applicationSecretInput.value, '');
    assert.equal(panel.applicationSecretBox.hidden, true);
});

test('issuer status clearly distinguishes configured and disabled providers', async () => {
    const panel = fixture();
    panel.callTool = async () => ({ enabled: false });
    await panel.refreshOidcStatus();
    assert.match(panel.oidcStatusEl.textContent, /disabled.*USERPERSISTO_OIDC_ISSUER/);
    panel.callTool = async () => ({ enabled: true, issuer: 'https://id.example/service/oidc', discoveryUrl: 'https://id.example/service/oidc/.well-known/openid-configuration' });
    await panel.refreshOidcStatus();
    assert.match(panel.oidcStatusEl.textContent, /Issuer: https:\/\/id.example\/service\/oidc/);
    assert.match(panel.oidcStatusEl.textContent, /Discovery: .*openid-configuration/);
});
