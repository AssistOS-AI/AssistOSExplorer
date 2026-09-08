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

test('Administration accepts policy and applications while Billing remains unavailable', () => {
    const panel = fixture('administration');
    panel.switchPanel(null, 'policy');
    assert.equal(panel.state.activePanel, 'policy');
    panel.switchPanel(null, 'applications');
    assert.equal(panel.state.activePanel, 'applications');
    for (const target of ['provider', 'auth', 'users']) {
        panel.switchPanel(null, target);
        assert.equal(panel.state.activePanel, 'applications');
    }
});

test('ordinary accounts cannot select administrative controls', () => {
    const panel = fixture('administration', ['user']);
    panel.switchPanel(null, 'applications');
    panel.switchPanel(null, 'policy');
    assert.equal(panel.state.activePanel, 'auth');
});
