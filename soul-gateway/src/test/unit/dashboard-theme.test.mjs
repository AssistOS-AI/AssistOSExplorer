import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dashboardRoot = new URL('../../dashboard/', import.meta.url);

async function readDashboard(relativePath) {
    return readFile(new URL(relativePath, dashboardRoot), 'utf8');
}

describe('dashboard Explorer theme integration', () => {
    it('loads shared Explorer styles, fonts, and theme bootstrap before app styles', async () => {
        const html = await readDashboard('index.html');

        assert.match(html, /<link rel="stylesheet" href="\/explorer\/shared\/ui\/ui-common\.css" \/>/);
        assert.match(html, /<link rel="stylesheet" href="\/explorer\/assets\/fonts\/Inter\/inter\.css" \/>/);
        assert.match(html, /<link rel="stylesheet" href="\/explorer\/assets\/fonts\/JetBrainsMono\/jetbrains-mono\.css" \/>/);
        assert.match(html, /<script src="\.\/js\/theme-boot\.js"><\/script>/);
        assert.match(html, /<link rel="stylesheet" href="\.\/css\/theme\.css" \/>/);
        assert.match(html, /<script type="module" src="\.\/js\/theme\.mjs"><\/script>/);
        assert.doesNotMatch(html, /data-theme="dark"/);
    });

    it('resolves the theme from Explorer storage before first paint', async () => {
        const boot = await readDashboard('js/theme-boot.js');

        assert.match(boot, /assistosExplorerTheme/);
        assert.match(boot, /webchat_theme/);
        assert.match(boot, /prefers-color-scheme: dark/);
        assert.match(boot, /classList\.toggle\('theme-dark'/);
        assert.match(boot, /setAttribute\('data-theme'/);
    });

    it('applies the shared Explorer theme module and republishes changes', async () => {
        const theme = await readDashboard('js/theme.mjs');

        assert.match(theme, /from '\/explorer\/shared\/ui\/theme\.js'/);
        assert.match(theme, /initializeTheme\(\)/);
        assert.match(theme, /setAttribute\('data-theme'/);
        assert.match(theme, /sg-theme-change/);
        assert.match(theme, /addEventListener\('storage'/);
    });

    it('maps Explorer tokens onto DaisyUI themes for light and dark', async () => {
        const themeCss = await readDashboard('css/theme.css');

        assert.match(themeCss, /\[data-theme="light"\]/);
        assert.match(themeCss, /\[data-theme="dark"\]/);
        assert.match(themeCss, /--b1:/);
        assert.match(themeCss, /--bc:/);
        assert.match(themeCss, /--p:/);
        assert.match(themeCss, /var\(--default-font\)/);
        assert.match(themeCss, /var\(--mono-font\)/);
    });

    it('keeps app.css free of hardcoded colors and uses Explorer tokens', async () => {
        const appCss = await readDashboard('css/app.css');

        assert.doesNotMatch(appCss, /oklch\(/);
        assert.doesNotMatch(appCss, /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/);
        assert.match(appCss, /var\(--surface-soft\)/);
        assert.match(appCss, /var\(--accent\)/);
        assert.match(appCss, /var\(--file-exp-code-bg\)/);
    });

    it('renders charts with theme-aware colors', async () => {
        const app = await readDashboard('js/app.mjs');

        assert.match(app, /function chartTheme\(\)/);
        assert.match(app, /getPropertyValue\('--text-soft'\)/);
        assert.match(app, /getPropertyValue\('--border'\)/);
    });
});
