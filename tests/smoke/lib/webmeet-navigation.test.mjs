import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { chromium } from '@playwright/test';

test('WebMeet opens through the Explorer toolbar before using its framed dashboard', { timeout: 30_000 }, async () => {
    let running = false;
    const requests = [];
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://fixture.test');
        requests.push(url.pathname);
        if (url.pathname === '/auth/token') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ user: { id: 'fixture-owner', username: 'owner', roles: ['admin'] } }));
        } else if (url.pathname === '/activate') {
            running = true;
            response.end('ready');
        } else if (url.pathname === '/webmeetAgent/roomLoader.html') {
            response.setHeader('content-type', 'text/html');
            response.end(running
                ? '<div class="webmeet-dashboard"><button id="webmeetCreateRoomButton">Create room</button><input id="webmeetChatInput"><div id="webmeetChatList"><div class="webmeet-feed-item"></div></div><div class="webmeet-compose"><button data-local-action="sendChat" onclick="document.querySelector(\'.webmeet-feed-item\').textContent=document.querySelector(\'#webmeetChatInput\').value">Send</button></div></div>'
                : '<h1>Runtime disabled</h1>');
        } else {
            response.setHeader('content-type', 'text/html');
            response.end(`<div id="page_content"><button aria-label="WebMeet" onclick="openMeeting()">WebMeet</button></div>
                <script>async function openMeeting() {
                    await fetch('/activate');
                    const dialog = document.createElement('dialog');
                    dialog.innerHTML = '<expanded-modal><iframe class="expanded-modal-frame" title="WebMeet" src="/webmeetAgent/roomLoader.html"></iframe></expanded-modal>';
                    document.body.append(dialog); dialog.showModal();
                }</script>`);
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    process.env.SMOKE_BASE_URL = baseURL;
    process.env.SMOKE_NAVIGATION_TIMEOUT_MS = '1500';
    process.env.SMOKE_EXPECT_TIMEOUT_MS = '1500';
    let browser;
    try {
        const { openWebMeet, webMeetSurface, sendWebMeetChat, expectChatEntry, openStandaloneWebMeet, trySignInToWebMeet, rtcCandidateEvidence } = await import('./webmeet.mjs');
        browser = await chromium.launch();
        const page = await browser.newPage({ baseURL });
        const principal = await openWebMeet(page, { username: 'owner' }, { requireConfiguredPrincipal: true });
        assert.equal(principal.canonicalUsername, 'owner');
        assert.equal(new URL(page.url()).hash, '', 'the owner remains in the Explorer shell');
        assert.ok(requests.indexOf('/activate') < requests.indexOf('/webmeetAgent/roomLoader.html'));
        assert.equal(await page.locator('#webmeetCreateRoomButton').count(), 0, 'the dashboard is inside the iframe');
        await sendWebMeetChat(page, 'framed message');
        await expectChatEntry(page, 'framed message');
        assert.equal(await webMeetSurface(page).evaluate(() => window.frameElement?.title), 'WebMeet');
        // Synthetic stats belong only to the iframe. The same read in the shell would be empty.
        await webMeetSurface(page).evaluate(() => {
            window.__e2ePeerConnections = [{ getStats: async () => new Map([
                ['pair', { id: 'pair', type: 'candidate-pair', selected: true, state: 'succeeded' }],
            ]) }];
        });
        assert.equal(await page.evaluate(() => (window.__e2ePeerConnections || []).length), 0);
        assert.equal((await rtcCandidateEvidence(page)).length, 1, 'RTC probes must read the WebMeet iframe');
        await page.locator('expanded-modal iframe').evaluate((frame) => frame.remove());
        assert.throws(() => webMeetSurface(page), /frame is detached/);
        await openStandaloneWebMeet(page, { roomId: 'fixture-room' });
        await sendWebMeetChat(page, 'standalone message');
        await expectChatEntry(page, 'standalone message');
        assert.equal(webMeetSurface(page), page, 'standalone navigation clears the old frame');
        assert.equal(await trySignInToWebMeet(page, { username: 'owner' }), true);
        await expectChatEntry(page, '');
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
