import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/dashboard/theme.js', import.meta.url), 'utf8');
function browser({ storage = {}, dark = false, blocked = false } = {}) {
    const listeners = new Map();
    const root = { dataset: {}, classList: { toggle() {} } };
    const system = { matches: dark, addEventListener: (_name, handler) => listeners.set('system', handler) };
    const window = { localStorage: { getItem: (key) => { if (blocked) throw new Error('Storage blocked'); return storage[key] || null; } },
        matchMedia: () => system, addEventListener: (name, handler) => listeners.set(name, handler) };
    runInNewContext(source, { window, document: { documentElement: root } });
    return { root, listeners, storage, system };
}

test('dashboard inherits the Explorer preference before falling back to webchat or system appearance', () => {
    assert.equal(browser({ storage: { assistosExplorerTheme: 'dark' } }).root.dataset.theme, 'dark');
    assert.equal(browser({ storage: { assistosExplorerTheme: 'light', webchat_theme: 'dark' }, dark: true }).root.dataset.theme, 'light');
    assert.equal(browser({ storage: { webchat_theme: 'obsidian' } }).root.dataset.theme, 'dark');
    assert.equal(browser({ dark: true }).root.dataset.theme, 'dark');
    assert.equal(browser().root.dataset.theme, 'light');
    assert.equal(browser({ blocked: true, dark: true }).root.dataset.theme, 'dark');
});

test('existing account tabs follow theme changes from another tab and OS changes only without a preference', () => {
    const fixture = browser();
    fixture.system.matches = true;
    fixture.listeners.get('system')();
    assert.equal(fixture.root.dataset.theme, 'dark');
    fixture.storage.assistosExplorerTheme = 'light';
    fixture.listeners.get('storage')({ key: 'assistosExplorerTheme' });
    assert.equal(fixture.root.dataset.theme, 'light');
    fixture.listeners.get('system')();
    assert.equal(fixture.root.dataset.theme, 'light');
    delete fixture.storage.assistosExplorerTheme;
    fixture.listeners.get('storage')({ key: null });
    assert.equal(fixture.root.dataset.theme, 'dark');
});

test('every account and administration page initializes appearance before loading styles', async () => {
    for (const name of ['index', 'users', 'roles', 'applications', 'authentication']) {
        const html = await readFile(new URL(`../public/dashboard/${name}.html`, import.meta.url), 'utf8');
        assert.ok(html.indexOf('src="theme.js"') >= 0, name);
        assert.ok(html.indexOf('src="theme.js"') < html.indexOf('href="dashboard.css"'), name);
    }
});
