import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { UserpersistoSettings } from '../public/dashboard/management.mjs';

const pages = { users: 'admin.users.manage', applications: 'admin.agentSettings.manage', policy: 'admin.agentSettings.manage' };

function fixture(page, capabilities = []) {
    const node = { hidden: true };
    const element = {
        getAttribute: (key) => key === 'data-initial-panel' ? page : null,
        querySelectorAll: () => [node],
    };
    const panel = new UserpersistoSettings(element, () => {});
    panel.syncPanelFromAttributes();
    panel.state.authProfile = { roles: ['admin'], capabilities };
    return { panel, node, element };
}

test('each management page fixes one panel and ignores a different active-panel attribute', () => {
    for (const page of Object.keys(pages)) {
        const { panel, element } = fixture(page);
        assert.deepEqual([...panel.allowedPanels()], [page]);
        assert.equal(panel.state.activePanel, page);
        element.getAttribute = (key) => key === 'data-initial-panel' ? page : 'auth';
        panel.syncPanelFromAttributes();
        assert.equal(panel.state.activePanel, page);
        assert.equal(typeof panel.switchPanel, 'undefined');
        const visibility = {};
        element.querySelectorAll = () => Object.keys(pages).map((section) => ({
            dataset: { section }, classList: { toggle: (_class, hidden) => { visibility[section] = !hidden; } },
        }));
        panel.renderPanels();
        for (const [section, visible] of Object.entries(visibility)) assert.equal(visible, section === page);
    }
});

test('management capabilities grant only their matching page and an admin role alone grants none', () => {
    for (const [page, required] of Object.entries(pages)) {
        for (const capabilities of [[], ['admin.users.manage'], ['admin.agentSettings.manage']]) {
            const { panel } = fixture(page, capabilities);
            assert.equal(panel.isAdministrator(), capabilities.includes(required), `${page}: ${capabilities}`);
        }
    }
});

test('initial profile loading fetches only the selected authorized page data', async () => {
    for (const [page, capability] of Object.entries(pages)) {
        const { panel, node } = fixture(page, [capability]);
        const calls = [];
        panel.callTool = async (name) => { calls.push(name); return { user: { id: 'actor' }, roles: ['custom-manager'], capabilities: [capability] }; };
        panel.loadUsersPage = async () => { calls.push('users'); };
        panel.refreshApplications = async () => { calls.push('applications'); };
        panel.refreshAuthPolicy = async () => { calls.push('policy'); };
        await panel.refreshAuthProfile();
        assert.deepEqual(calls, ['userpersisto_profile_get', page]);
        assert.equal(node.hidden, false);
    }
});

test('unauthorized profiles leave page controls hidden without loading administrative data', async () => {
    for (const page of Object.keys(pages)) {
        const { panel, node } = fixture(page);
        const calls = [];
        panel.callTool = async (name) => { calls.push(name); return { user: { id: 'actor' }, roles: ['admin'], capabilities: [] }; };
        panel.loadUsersPage = panel.refreshApplications = panel.refreshAuthPolicy = async () => { throw new Error('Unauthorized data loaded'); };
        await panel.refreshAuthProfile();
        assert.deepEqual(calls, ['userpersisto_profile_get']);
        assert.equal(node.hidden, true);
        assert.equal(panel.state.statusType, 'error');
    }
});

test('late profile responses cannot restore access after page disposal', async () => {
    const { panel, node } = fixture('applications');
    let resolve;
    panel.callTool = () => new Promise((done) => { resolve = done; });
    let loaded = false;
    panel.refreshApplications = async () => { loaded = true; };
    const pending = panel.refreshAuthProfile();
    panel.afterUnload();
    resolve({ user: { id: 'actor' }, capabilities: ['admin.agentSettings.manage'] });
    await pending;
    assert.equal(panel.state.authProfile, null);
    assert.equal(node.hidden, true);
    assert.equal(loaded, false);
});

test('standalone management documents contain one form surface and personal account stays separate', async () => {
    const directory = new URL('../public/dashboard/', import.meta.url);
    for (const [file, page] of [['users.html', 'users'], ['applications.html', 'applications'], ['authentication.html', 'policy']]) {
        const html = await fs.readFile(new URL(file, directory), 'utf8');
        assert.ok(html.includes(`data-initial-panel="${page}"`));
        assert.equal([...html.matchAll(/data-section=/g)].length, 1);
        assert.doesNotMatch(html, /<userpersisto-settings|<admin-settings-panel|profile-form|account-enrollment/);
    }
    const account = await fs.readFile(new URL('index.html', directory), 'utf8');
    assert.match(account, /id="profile-form"/);
    assert.match(account, /id="security-heading"/);
    assert.doesNotMatch(account, /id="usersList"|id="applicationsList"|id="selfRegistrationEnabled"/);
});
