import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const require = createRequire(path.join(root, 'tests/smoke/package.json'));
const { chromium } = require('playwright');
const component = '/explorer/web-components/modals/coding-sessions-modal/';
const workerAttach = 'b'.repeat(32);
const normal = 'n'.repeat(32), supervisor = 's'.repeat(32), worker = 'w'.repeat(32), attach = 'a'.repeat(32);

// Isolated browser/component contract test. No workspace deployment, robots or model calls.
test('folder coding chooser drives both modes, opens Live Sessions handoffs and kills only the selected process', async t => {
    const calls = [];
    const running = new Set([normal]);
    let pair = false;
    let stopped = false;
    let failHistory = false;
    let holdHistory = false;
    const html = fs.readFileSync(path.join(root, component, 'coding-sessions-modal.html'), 'utf8');
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://fixture');
        if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (url.pathname === '/fixture') {
            res.setHeader('content-type', 'text/html');
            res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/explorer/shared/ui/ui-common.css"><style>body {font-family:var(--default-font); background:var(--bg); padding:32px;} coding-sessions-modal {max-width:1040px; margin:auto; padding:24px; background:var(--surface); border:1px solid var(--border); border-radius:16px;}</style><link rel="stylesheet" href="${component}coding-sessions-modal.css">
                <coding-sessions-modal>${html}</coding-sessions-modal><script type="module">
                import { CodingSessionsModal } from '${component}coding-sessions-modal.js';
                window.assistOS = { user: {roles:['admin']}, UI: {closeModal(){}} };
                const element = document.querySelector('coding-sessions-modal');
                const presenter = new CodingSessionsModal(element, () => {}, {dir:'folder with spaces'});
                element.addEventListener('click', event => { const button=event.target.closest('[data-local-action]'); if(button) presenter[button.dataset.localAction](); });
                window.presenter=presenter; presenter.afterRender();
                </script>`); return;
        }
        if (url.pathname.startsWith('/webtty')) {
            let body = ''; for await (const chunk of req) body += chunk;
            const input = body ? JSON.parse(body) : {};
            calls.push({ path: url.pathname, method: req.method, body: input });
            let payload = { ok: true };
            if (url.pathname === '/webtty/coding-sessions') {
                assert.equal(input.dir, 'folder with spaces');
                if (input.action === 'robots') payload.robots = [{ id: 'default', name: 'Default robot' }, ...Array.from({ length: 45 }, (_, i) => ({ id: `robot-${i}`, name: `Robot ${i}` }))];
                if (input.action === 'robots') payload.codingAgents = ['vibe', 'claude'];
                if (input.action === 'agents') {
                    if (input.robot === 'robot-1') await new Promise(resolve => setTimeout(resolve, 200));
                    payload.codingAgents = input.robot === 'robot-1' ? ['codex'] : ['vibe', 'claude'];
                }
                if (input.action === 'overview') {
                    if (failHistory) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false })); return; }
                    payload.running = running.has(normal) ? [{ id: normal, title: '<img src=x> Current', status: 'detached', robotId: 'default', robotName: 'Default robot', codingAgent: 'vibe' }] : [];
                    payload.refreshing = holdHistory;
                    payload.sessions = holdHistory ? [] : [{ id: 'saved', title: 'Saved conversation' }, ...Array.from({ length: 35 }, (_, i) => ({ id: `saved-${i}`, title: `History ${i}` }))].map(entry => ({ ...entry, robotId: 'default', robotName: 'Default robot', codingAgent: 'vibe' }));
                }
                if (input.action === 'kill') { running.delete(input.id); if (input.id === normal) stopped = true; payload.historySaved = true; }
                if (input.action === 'overview' && stopped) payload.sessions.push({ id: 'stopped-native', title: 'Stopped conversation', robotId: 'default', robotName: 'Default robot', codingAgent: 'vibe' });
                if (input.action === 'launch' || input.action === 'open-role') payload.attach = attach;
                if (input.action === 'create-pair') { pair = true; running.add(supervisor); running.add(worker); payload.attach = attach; payload.worker = { terminalId: worker, attach: workerAttach }; }
                if (input.action === 'pairs') payload.pairs = pair ? [{ id: 'pair', createdAt: 1000, roles: [
                    { role: 'supervisor', robotId: 'default', codingAgent: 'vibe', terminalId: supervisor, running: running.has(supervisor) },
                    { role: 'worker', robotId: 'default', codingAgent: 'claude', terminalId: worker, running: running.has(worker) },
                ] }] : [];
            } else if (req.method === 'DELETE') running.delete(url.pathname.split('/').at(-1));
            else if (url.pathname.endsWith('/attach-tokens')) { payload.attach = attach; payload.expiresAt = Date.now() + 10000; }
            else { res.setHeader('content-type', 'text/html'); res.end('WebTTY handoff'); return; }
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload)); return;
        }
        const file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
        res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/javascript');
        res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => { errors.push(error.message); t.diagnostic(error.message); });
    page.on('console', message => { if (message.type() === 'error') t.diagnostic(message.text()); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}/fixture`);
    page.setDefaultTimeout(10000);
    const click = name => page.getByRole(['Coding sessions', 'Supervised sessions'].includes(name) ? 'tab' : 'button', { name, exact: true }).click();
    const opened = async action => { const next = page.waitForEvent('popup'); await action(); const tab = await next;
        await tab.waitForURL(`**/webtty/#attach=${attach}`); assert.equal(await tab.evaluate(() => window.opener), null); await tab.close(); };
    await page.getByRole('button', { name: 'robot: Default robot · coding agent: vibe · Saved conversation', exact: true }).waitFor();
    assert.equal(calls.some(call => ['robots', 'agents', 'sessions'].includes(call.body.action)), false, 'initial listing only reads the index');
    const chooseRobot = async (role, name = 'Default robot') => {
        await page.getByRole('combobox', { name: `${role} robot`, exact: true }).fill(name);
        await page.getByRole('option', { name, exact: true }).click();
    };
    const chooseAgent = async (role, agent) => {
        const select = page.getByRole('combobox', { name: `${role} coding agent`, exact: true });
        await select.locator(`option[value="${agent}"]`).waitFor({ state: 'attached' });
        await select.selectOption(agent);
    };
    const bounds = await page.evaluate(() => {
        const list = document.querySelector('#codingList');
        const header = document.querySelector('.coding-session-navigation');
        const before = header.getBoundingClientRect().top;
        list.scrollTop = list.scrollHeight;
        return { scrolls: list.scrollHeight > list.clientHeight, scrollTop: list.scrollTop,
            fixed: header.getBoundingClientRect().top === before,
            shellOverflow: getComputedStyle(document.querySelector('.coding-sessions-shell')).overflowY,
            bodyOverflow: getComputedStyle(document.querySelector('.modal-body')).overflowY };
    });
    assert.ok(bounds.scrolls && bounds.scrollTop > 0 && bounds.fixed);
    assert.equal(bounds.shellOverflow, 'hidden'); assert.equal(bounds.bodyOverflow, 'hidden');
    await click('+ New coding session');
    const search = page.getByRole('combobox', { name: 'Coding session robot', exact: true });
    await chooseAgent('Coding session', 'vibe');
    assert.equal(await page.getByRole('button', { name: 'Start coding session', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.coding-session-config').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    await search.click();
    assert.equal(await page.getByRole('listbox').evaluate(list => list.scrollHeight > list.clientHeight), true);
    await search.press('Escape');
    assert.equal(await search.getAttribute('aria-expanded'), 'false');
    await search.fill('robot 44');
    assert.equal(await page.getByRole('listbox').getByRole('option').count(), 1);
    await search.fill('no matching robot');
    await page.getByText('No robots found', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Start coding session', exact: true }).isDisabled(), true);
    await search.fill('Default');
    await search.press('ArrowDown'); await search.press('Enter');
    await chooseAgent('Coding session', 'vibe');
    assert.equal(await page.getByRole('button', { name: 'Start coding session', exact: true }).isEnabled(), true);
    await search.fill('Robot 1');
    assert.equal(await page.getByRole('button', { name: 'Start coding session', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('combobox', { name: 'Coding session coding agent', exact: true }).inputValue(), 'vibe');
    await chooseRobot('Coding session', 'Robot 1');
    await chooseRobot('Coding session');
    await chooseAgent('Coding session', 'vibe');
    assert.equal(calls.filter(call => call.body.action === 'agents').length, 0, 'agent selection is independent of the robot');
    assert.equal(await page.getByRole('combobox', { name: 'Coding session coding agent', exact: true }).inputValue(), 'vibe');
    const codingTab = page.getByRole('tab', { name: 'Coding sessions', exact: true });
    await codingTab.focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.activeElement?.id === 'supervisedTab');
    assert.equal(await page.locator('#supervisedTab').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.activeElement?.id === 'codingTab');
    assert.equal(await codingTab.getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'robot: Default robot · coding agent: vibe · Saved conversation', exact: true }).waitFor();
    assert.equal(await search.count(), 0, 'robot search only appears in the creation form');
    if (process.env.CODING_MODAL_SCREENSHOT) await page.screenshot({ path: process.env.CODING_MODAL_SCREENSHOT });
    assert.equal(await page.locator('#codingList img').count(), 0);
    assert.equal(await page.locator('.has-actions .coding-session-caption').textContent(), '<img src=x> Current');
    await click('+ New coding session'); await chooseRobot('Coding session');
    await chooseAgent('Coding session', 'vibe');
    await opened(() => click('Start coding session'));
    assert.equal(calls.find(call => call.body.action === 'launch').body.resume, null);
    await opened(() => click('robot: Default robot · coding agent: vibe · Saved conversation'));
    assert.equal(calls.filter(call => call.body.action === 'launch').at(-1).body.resume, 'saved');
    await page.locator('summary').click(); await click('Kill'); await click('Confirm kill');
    await page.waitForFunction(() => !document.querySelector('summary'));
    assert.equal(running.has(normal), false);
    await page.getByRole('button', { name: 'robot: Default robot · coding agent: vibe · Stopped conversation', exact: true }).waitFor();
    await opened(() => click('robot: Default robot · coding agent: vibe · Stopped conversation'));
    assert.deepEqual(calls.filter(call => call.body.action === 'launch').at(-1).body, { action: 'launch', dir: 'folder with spaces', robot: 'default', codingAgent: 'vibe', resume: 'stopped-native' });
    await click('Supervised sessions'); await click('+ New supervised session');
    await chooseAgent('Supervisor', 'vibe'); await chooseRobot('Supervisor');
    assert.equal(await page.getByRole('button', { name: 'Start and open both sessions', exact: true }).isDisabled(), true);
    await chooseAgent('Worker', 'claude'); await chooseRobot('Worker');
    if (process.env.CODING_MODAL_SCREENSHOT) await page.screenshot({ path: process.env.CODING_MODAL_SCREENSHOT });
    await page.setViewportSize({ width: 600, height: 800 });
    assert.equal(await page.locator('.coding-session-configs').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length), 1);
    await page.setViewportSize({ width: 1280, height: 720 });
    const beforePair = calls.filter(call => call.body.action === 'create-pair').length;
    await page.evaluate(() => {
        window.pairOriginalOpen = window.open;
        let count = 0;
        window.open = (...args) => ++count === 2 ? null : (window.reservedPairTab = window.pairOriginalOpen(...args));
    });
    await click('Start and open both sessions');
    assert.match(await page.locator('#codingStatus').textContent(), /Allow multiple popups/);
    assert.equal(calls.filter(call => call.body.action === 'create-pair').length, beforePair);
    assert.equal(await page.evaluate(() => window.reservedPairTab.closed), true);
    await page.evaluate(() => { window.open = window.pairOriginalOpen; });
    const pairTabs = new Promise(resolve => {
        const tabs = [];
        const listener = tab => { tabs.push(tab); if (tabs.length === 2) { page.off('popup', listener); resolve(tabs); } };
        page.on('popup', listener);
    });
    await click('Start and open both sessions');
    const tabs = await pairTabs;
    await Promise.all(tabs.map((tab, i) => tab.waitForURL(`**/webtty/#attach=${i === 0 ? attach : workerAttach}`)));
    for (const tab of tabs) { assert.equal(await tab.evaluate(() => window.opener), null); await tab.close(); }
    const created = calls.find(call => call.body.action === 'create-pair').body;
    assert.deepEqual(created.supervisor, { robotId: 'default', codingAgent: 'vibe' });
    assert.deepEqual(created.worker, { robotId: 'default', codingAgent: 'claude' });
    await page.getByRole('button', { name: /Supervisor: robot: default · coding agent: vibe → Worker: robot: default · coding agent: claude/ }).click();
    assert.equal(await page.locator('.coding-session-running').first().textContent(), 'running');
    assert.equal(await page.locator('.coding-session-running').first().evaluate(el => getComputedStyle(el).color), 'rgb(4, 120, 87)');
    await opened(() => click('● Worker · robot: default · coding agent: claude · running'));
    const workerRow = page.locator('.coding-session-row').filter({ has: page.getByRole('button', { name: '● Worker · robot: default · coding agent: claude · running', exact: true }) });
    assert.deepEqual(await workerRow.locator('.coding-session-pill').allTextContents(), ['default', 'claude']);
    assert.equal(await workerRow.locator('summary').textContent(), '⋮');
    assert.equal(await workerRow.locator('.coding-session-choice').evaluate(el => getComputedStyle(el, '::after').content), 'none');
    await workerRow.locator('summary').click(); await workerRow.getByRole('button', { name: 'Kill', exact: true }).click();
    await workerRow.getByRole('button', { name: 'Confirm kill', exact: true }).click();
    await page.getByRole('button', { name: 'Worker · robot: default · coding agent: claude', exact: true }).waitFor();
    assert.equal(running.has(supervisor), true);
    assert.equal(running.has(worker), false);
    assert.deepEqual(calls.filter(call => call.body.action === 'kill').map(call => call.body.id), [normal, worker]);
    await click('Coding sessions'); await click('+ New coding session'); await chooseRobot('Coding session'); await chooseAgent('Coding session', 'vibe');
    const launches = calls.filter(call => call.body.action === 'launch').length;
    await page.evaluate(() => { window.originalOpen = window.open; window.open = () => null; });
    await click('Start coding session');
    assert.match(await page.locator('#codingStatus').textContent(), /Allow popups/u);
    assert.equal(calls.filter(call => call.body.action === 'launch').length, launches);
    await page.evaluate(() => { window.open = window.originalOpen; });
    holdHistory = true;
    await click('Coding sessions');
    await page.waitForFunction(() => !window.presenter.busy);
    await page.getByRole('button', { name: '+ New coding session', exact: true }).waitFor();
    const duringUpdate = calls.length;
    await new Promise(resolve => setTimeout(resolve, 3200));
    assert.equal(calls.length, duringUpdate, 'an active background update does not cause browser polling');
    assert.equal(await page.locator('#codingStatus').textContent(), '');
    // A hung native catalog must not block New or robot navigation.
    await click('+ New coding session');
    await page.getByRole('combobox', { name: 'Coding session robot', exact: true }).waitFor();
    holdHistory = false;
    failHistory = true;
    await click('Coding sessions');
    await page.getByText(/Coding sessions are unavailable/).waitFor();
    const requestCount = calls.length;
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.equal(calls.length, requestCount, 'failed catalogs are not retried automatically');
    failHistory = false;
    await click('Refresh');
    await page.getByRole('button', { name: 'robot: Default robot · coding agent: vibe · Saved conversation', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Rebuild index' }).count(), 0);
    await page.evaluate(() => { window.assistOS.user = { roles: ['user'] }; });
    await click('Refresh');
    assert.match(await page.locator('#codingStatus').textContent(), /Administrator access/u);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.presenter.afterUnload());
    await page.close();
});
