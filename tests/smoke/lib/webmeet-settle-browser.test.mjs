import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { chromium } from '@playwright/test';

// Real-Chromium checks of the WebMeet idle point. Each fixture document is the
// room loader path on the configured origin and changes one idle condition on
// a timer; the wait must not return before that change has happened.
const LATE_REQUEST_START_MS = 400;
const HELD_REQUEST_MS = 300;

test('the WebMeet idle point waits for a late request, loader and room flags', { timeout: 90_000 }, async (t) => {
    const completed = [];
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://fixture.test');
        if (url.pathname === '/webmeetAgent/held.json') {
            setTimeout(() => {
                response.setHeader('content-type', 'application/json');
                response.end('{}', () => completed.push(url.searchParams.get('case')));
            }, HELD_REQUEST_MS);
            return;
        }
        const scenario = url.searchParams.get('case');
        const scripts = {
            // Nothing is in flight for LATE_REQUEST_START_MS after load, which is
            // shorter than the quiet window; then one request starts.
            'late-request': `setTimeout(() => fetch('/webmeetAgent/held.json?case=late-request'), ${LATE_REQUEST_START_MS});`,
            // The room loader is still marked loading, with no request in flight.
            loader: `setTimeout(() => { document.documentElement.setAttribute('data-app-loading', 'false'); window.flagCleared = Date.now(); }, 1500);`,
            // The dashboard is joining a room, with no request in flight.
            joining: `const presenter = { state: { joiningMeetingId: 'room_1', roomTransition: { active: true } } };
                document.querySelector('webmeet-dashboard').webSkelPresenter = presenter;
                setTimeout(() => { presenter.state.joiningMeetingId = ''; presenter.state.roomTransition = { active: false }; window.flagCleared = Date.now(); }, 1500);`,
        };
        response.setHeader('content-type', 'text/html');
        response.end(`<html data-app-loading="${scenario === 'loader' ? 'true' : 'false'}"><body>
            <webmeet-dashboard></webmeet-dashboard><script>${scripts[scenario] || ''}</script></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    process.env.SMOKE_BASE_URL = baseURL;
    process.env.SMOKE_NAVIGATION_TIMEOUT_MS = '10000';
    let browser;
    try {
        const { trackWebMeetRequests, waitForWebMeetSettled, WEBMEET_SETTLE_QUIET_MS } = await import('./webmeet-settle.mjs');
        assert.ok(WEBMEET_SETTLE_QUIET_MS > LATE_REQUEST_START_MS, 'the late request starts inside the quiet window');
        browser = await chromium.launch();
        const open = async (scenario) => {
            const page = await browser.newPage({ baseURL });
            trackWebMeetRequests(page);
            await page.goto(`/webmeetAgent/roomLoader.html?case=${scenario}`, { waitUntil: 'load' });
            return page;
        };

        await t.test('a request that starts inside the quiet window is waited for', async () => {
            const page = await open('late-request');
            await waitForWebMeetSettled(page, page.mainFrame());
            assert.deepEqual(completed, ['late-request'], 'the wait returned only after the late request completed');
            await page.close();
        });

        await t.test('control: without a quiet window the wait returns before that request starts', async () => {
            completed.length = 0;
            const page = await open('late-request');
            await waitForWebMeetSettled(page, page.mainFrame(), { quietMs: 0 });
            assert.deepEqual(completed, [], 'this fixture distinguishes the quiet window');
            await page.close();
        });

        for (const scenario of ['loader', 'joining']) {
            await t.test(`the ${scenario} flag holds the wait without any request in flight`, async () => {
                const page = await open(scenario);
                await waitForWebMeetSettled(page, page.mainFrame(), { quietMs: 0 });
                assert.equal(typeof await page.evaluate(() => window.flagCleared), 'number', 'the wait returned only after the flag cleared');
                await page.close();
            });
        }

        await t.test('a page without request tracking is refused', async () => {
            const page = await browser.newPage({ baseURL });
            await page.goto('/webmeetAgent/roomLoader.html?case=none');
            await assert.rejects(waitForWebMeetSettled(page, page.mainFrame()), /request tracking must start/);
            await page.close();
        });
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
