import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../tests/smoke/package.json', import.meta.url));
const { chromium } = require('playwright');

test('robot combobox opens all choices, filters while typing and supports mouse and keyboard', async t => {
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent('<input id="robot" role="combobox"><div id="options" role="listbox" hidden></div><button>Outside</button>');
    const source = fs.readFileSync(new URL('../../web-components/modals/terminal-target-modal/robot-combobox.js', import.meta.url), 'utf8');
    await page.addScriptTag({ content: source.replace('export function', 'function') + `
        let current = { key: 'default-id', display: 'default' };
        window.picks = [];
        window.control = bindRobotCombobox({input: document.querySelector('input'), list: document.querySelector('#options'),
            robots: () => [{key:'default-id',display:'default'}, {key:'dev-id',display:'Dev-test'}],
            selected: () => current, busy: () => false,
            choose: key => { window.picks.push(key); current = {key,display:key==='dev-id'?'Dev-test':'default'}; }});
    ` });
    const input = page.getByRole('combobox');
    await input.click();
    assert.equal(await page.getByRole('option').count(), 2);
    await input.fill('DEV');
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Dev-test']);
    await page.getByRole('option').click();
    assert.equal(await input.inputValue(), 'Dev-test');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    await input.click();
    assert.equal(await page.getByRole('option').count(), 2);
    await input.fill('def'); await input.press('ArrowDown'); await input.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.picks), ['dev-id', 'default-id']);
    await input.click(); await input.fill('missing');
    assert.equal(await page.getByText('No robots found').isVisible(), true);
    await input.press('Escape');
    assert.equal(await input.inputValue(), 'default');
    await input.click(); await page.getByRole('button', { name: 'Outside' }).click();
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => window.control.dispose());
    await input.click();
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
});
