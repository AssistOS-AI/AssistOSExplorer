import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from '@playwright/test';

test('WebMeet opens through the Explorer toolbar before using its framed dashboard', { timeout: 30_000 }, async () => {
    let running = false;
    let authenticatedUsername = 'owner';
    const requests = [];
    const modalSource = (await readFile(new URL('../../../explorer/web-components/modals/expanded-modal/expanded-modal.js', import.meta.url), 'utf8'))
        .replace(/from "[^"]+"/g, 'from "/fixture-deps.mjs"');
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://fixture.test');
        requests.push(url.pathname);
        if (url.pathname === '/auth/token') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ user: { id: `fixture-${authenticatedUsername}`, username: authenticatedUsername, roles: ['admin'] } }));
        } else if (url.pathname === '/expanded-modal.mjs') {
            response.setHeader('content-type', 'text/javascript');
            response.end(modalSource);
        } else if (url.pathname === '/fixture-deps.mjs') {
            response.setHeader('content-type', 'text/javascript');
            response.end(`export default {};
                export const ensureMarketplaceAgentRunning = null, relayBreadcrumbFieldEvent = null,
                    relayBreadcrumbSelectEvent = null, syncBreadcrumbSelects = null, hasFocusedBreadcrumbField = null,
                    probeAgentRuntimeMcp = null, probeAgentRuntimeRouteStability = null,
                    probeAgentRuntimeTargetAndMcp = null, probeAgentRuntimeTarget = null,
                    waitForAgentRuntimeAvailability = null, readMarketplaceAgent = null;`);
        } else if (url.pathname === '/activate') {
            running = true;
            response.end('ready');
        } else if (url.pathname === '/webmeetAgent/roomLoader.html') {
            response.setHeader('content-type', 'text/html');
            response.end(running
                ? `<div class="webmeet-dashboard"><button id="webmeetCreateRoomButton">Create room</button><input id="webmeetChatInput"><div id="webmeetChatList"><div class="webmeet-feed-item"></div></div><div class="webmeet-compose"><button data-local-action="sendChat" onclick="document.querySelector('.webmeet-feed-item').textContent=document.querySelector('#webmeetChatInput').value">Send</button></div></div>
                    <script>
                    window.__beforeExpandedModalClose = () => !parent.sessionStorage.getItem('refuseClose');
                    window.__onExpandedModalClose = async () => {
                        parent.closeEvents.push('cleanup-start');
                        await new Promise(resolve => setTimeout(resolve, 75));
                        parent.closeEvents.push('cleanup-finished');
                    };</script>`
                : '<h1>Runtime disabled</h1>');
        } else {
            response.setHeader('content-type', 'text/html');
            response.end(`<div id="page_content"><button aria-label="WebMeet" onclick="openMeeting()">WebMeet</button></div>
                <script type="module">
                import { ExpandedModal } from '/expanded-modal.mjs';
                window.closeEvents = [];
                window.assistOS = { UI: { closeModal(element) {
                    window.closeEvents.push('dialog-closed');
                    sessionStorage.removeItem('explorer.expandedModal.resume');
                    element.closest('dialog').close();
                    element.closest('dialog').remove();
                } } };
                window.openMeeting = async function() {
                    const activation = await fetch('/activate');
                    await activation.text();
                    mountMeeting();
                };
                function mountMeeting() {
                    const dialog = document.createElement('dialog');
                    dialog.innerHTML = '<expanded-modal><button id="expandedModalClose">Close panel</button><iframe class="expanded-modal-frame" title="WebMeet" src="/webmeetAgent/roomLoader.html"></iframe></expanded-modal>';
                    document.body.append(dialog); dialog.showModal();
                    sessionStorage.setItem('explorer.expandedModal.resume', JSON.stringify({
                        resume: true, title: 'WebMeet', url: '/webmeetAgent/roomLoader.html',
                    }));
                    const element = dialog.querySelector('expanded-modal');
                    const presenter = Object.assign(Object.create(ExpandedModal.prototype), {
                        element, dialog, mode: 'iframe', closed: false, closing: false,
                        frame: element.querySelector('iframe'), guardedDocuments: new WeakSet(),
                        loadController: new AbortController(),
                        cancelLoading() { this.frame.remove(); },
                    });
                    element.querySelector('#expandedModalClose').onclick = () => presenter.closeModal();
                    window.closeEvents.push('mounted');
                }
                if (sessionStorage.getItem('explorer.expandedModal.resume')) {
                    // Shell preload is asynchronous; signIn's identity fetch may
                    // finish before the restored panel has mounted.
                    setTimeout(mountMeeting, 150);
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
        const browserErrors = [];
        page.on('console', (message) => {
            if (message.type() === 'error') browserErrors.push(message.text());
        });
        page.on('pageerror', (error) => browserErrors.push(error.message));
        page.on('requestfailed', (request) => browserErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
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
        await openWebMeet(page, { username: 'owner' }, { requireConfiguredPrincipal: true });
        assert.deepEqual(await page.evaluate(() => window.closeEvents), [
            'mounted', 'cleanup-start', 'cleanup-finished', 'dialog-closed', 'mounted',
        ], 'resumed panel must complete the real close handler before toolbar reentry');
        await expectChatEntry(page, '');
        const activationCount = () => requests.filter((pathname) => pathname === '/activate').length;
        const beforeMismatch = activationCount();
        authenticatedUsername = 'member';
        await assert.rejects(openWebMeet(page, { username: 'owner' }, { requireConfiguredPrincipal: true }),
            /does not match the configured account identity/);
        assert.equal(activationCount(), beforeMismatch, 'a different account cannot activate the owner cleanup surface');
        await page.locator('expanded-modal iframe').waitFor();
        assert.deepEqual(await page.evaluate(() => window.closeEvents), ['mounted'], 'failed identity verification cannot close the resumed panel');
        authenticatedUsername = 'owner';
        await page.evaluate(() => sessionStorage.setItem('refuseClose', 'true'));
        await assert.rejects(openWebMeet(page, { username: 'owner' }, { requireConfiguredPrincipal: true }),
            /toHaveCount/);
        assert.equal(activationCount(), beforeMismatch, 'a refused close cannot reopen WebMeet');
        assert.deepEqual(await page.evaluate(() => window.closeEvents), ['mounted'], 'refused close preserves the panel without invoking cleanup');
        await page.evaluate(() => sessionStorage.removeItem('refuseClose'));
        await openWebMeet(page, { username: 'owner' }, { requireConfiguredPrincipal: true });
        await page.locator('expanded-modal iframe').evaluate((frame) => frame.remove());
        assert.throws(() => webMeetSurface(page), /frame is detached/);
        await openStandaloneWebMeet(page, { roomId: 'fixture-room' });
        await sendWebMeetChat(page, 'standalone message');
        await expectChatEntry(page, 'standalone message');
        assert.equal(webMeetSurface(page), page, 'standalone navigation clears the old frame');
        assert.equal(await trySignInToWebMeet(page, { username: 'owner' }), true);
        await expectChatEntry(page, '');
        assert.equal(await trySignInToWebMeet(page, { username: 'owner' }), true, 'optional sign-in also handles a resumed panel');
        assert.deepEqual(await page.evaluate(() => window.closeEvents), [
            'mounted', 'cleanup-start', 'cleanup-finished', 'dialog-closed', 'mounted',
        ]);
        assert.deepEqual(browserErrors, [], 'fixture navigation must not suppress browser errors or failed requests');
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
