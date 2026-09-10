import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../IDE-plugins/userpersisto-settings/userpersisto-settings.js', import.meta.url), 'utf8');
const { UserpersistoSettings } = await import(`data:text/javascript;base64,${Buffer.from(source.replace(/^import[\s\S]*?;\s*/, '')).toString('base64')}`);

function fixture(scope, roles = ['admin']) {
    const panel = new UserpersistoSettings({ getAttribute: (key) => key === 'data-settings-scope' ? scope : null }, () => {});
    panel.state.authProfile = { roles };
    panel.renderPanels = () => {};
    panel.clearApplicationSecret = () => {};
    panel.refreshApplications = () => {};
    return panel;
}

test('My Account rejects administrative panels even for an administrator', () => {
    const panel = fixture('account');
    for (const target of ['users', 'policy', 'applications', 'provider', '']) {
        panel.switchPanel(null, target);
        assert.equal(panel.state.activePanel, 'auth');
    }
});

test('Administration accepts only applications, excluding policy and duplicate user controls', () => {
    const panel = fixture('administration');
    panel.switchPanel(null, 'applications');
    assert.equal(panel.state.activePanel, 'applications');
    for (const target of ['provider', 'auth', 'users', 'policy', '', null]) {
        panel.switchPanel(null, target);
        assert.equal(panel.state.activePanel, 'applications');
    }
});

test('My Account loads workspace policy only for administrators', async () => {
    for (const roles of [['admin'], ['user'], ['selfRegistered']]) {
        const panel = fixture('account', roles);
        const calls = [];
        const adminNodes = [{ hidden: true }];
        panel.element.querySelectorAll = () => adminNodes;
        panel.callTool = async (name) => { calls.push(name); return { roles }; };
        panel.renderAuthProfile = () => {};
        panel.setStatus = () => {};
        panel.clearApplications = () => {};
        panel.refreshAuthPolicy = () => { calls.push('policy'); };
        await panel.refreshAuthProfile();
        assert.equal(calls.includes('policy'), roles.includes('admin'));
        assert.equal(adminNodes[0].hidden, !roles.includes('admin'));
    }
});

test('policy accompanies the account profile but never appears in Applications', () => {
    for (const scope of ['account', 'administration']) {
        const panel = fixture(scope);
        const visibility = {};
        panel.element.querySelectorAll = () => ['auth', 'policy', 'applications'].map(section => ({
            dataset: { section }, classList: { toggle: (_class, hidden) => { visibility[section] = !hidden; } }
        }));
        panel.clearEnrollment = () => {};
        panel.renderEnrollment = () => {};
        panel.state.activePanel = scope === 'account' ? 'auth' : 'applications';
        UserpersistoSettings.prototype.renderPanels.call(panel);
        assert.equal(visibility.policy, scope === 'account');
        assert.equal(visibility.auth, scope === 'account');
        assert.equal(visibility.applications, scope === 'administration');
    }
});

test('ordinary accounts cannot select administrative controls', () => {
    const panel = fixture('administration', ['user']);
    panel.switchPanel(null, 'applications');
    panel.switchPanel(null, 'policy');
    assert.equal(panel.state.activePanel, 'auth');
});
